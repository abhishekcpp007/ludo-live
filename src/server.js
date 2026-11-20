"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { Server } = require("socket.io");
const G = require("./game");
const S = require("./security");
const { Wallets } = require("./wallet");
const C = require("./catalog");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const ROOM_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LEN = 5;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const FRIEND_STAKES = [0, 100, 500, 2500];
const QUICK_STAKES = [100, 500, 2500];
const BOT_NAMES = ["Arjun", "Meera", "Kabir", "Zoya", "Rohan", "Isha", "Dev", "Tara"];

const DEFAULTS = {
  turnMs: 30 * SECOND,
  offlineTurnMs: 4 * SECOND,
  botMs: 1200,
  autoMoveMs: 1000,
  passMs: 1400,
  quickWaitMs: 12 * SECOND,
  botFillMs: 15 * SECOND,
  matchStartMs: 8 * SECOND,
  matchTickMs: SECOND,
  roomIdleMs: 15 * MINUTE,
  sweepMs: MINUTE,
  maxRooms: 1000,
  maxConnPerIp: 16,
  walletFile: process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "wallets.json") : null,
  trustProxy: process.env.TRUST_PROXY || "",
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

function loadStatic() {
  const files = new Map();
  const names = fs.readdirSync(PUBLIC_DIR).filter((n) => MIME[path.extname(n)]);
  const version = crypto.createHash("sha1");
  names.forEach((n) => version.update(fs.readFileSync(path.join(PUBLIC_DIR, n))));
  const v = version.digest("hex").slice(0, 10);
  for (const name of names) {
    const ext = path.extname(name);
    let body = fs.readFileSync(path.join(PUBLIC_DIR, name));
    if (name === "index.html") body = Buffer.from(body.toString().replace(/(src|href)="([a-z]+\.(?:js|css|svg))"/g, `$1="$2?v=${v}"`));
    files.set(`/${name}`, {
      type: MIME[ext],
      body,
      gzip: zlib.gzipSync(body, { level: zlib.constants.Z_BEST_COMPRESSION }),
      etag: `"${crypto.createHash("sha1").update(body).digest("base64url")}"`,
      cache: ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    });
  }
  files.set("/", files.get("/index.html"));
  return files;
}

function iceServers() {
  const list = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
  if (process.env.TURN_URL) {
    list.push({
      urls: process.env.TURN_URL.split(","),
      username: process.env.TURN_USER,
      credential: process.env.TURN_PASS,
    });
  }
  return list;
}

function createApp(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const files = loadStatic();
  const configBody = JSON.stringify({ iceServers: iceServers() });
  const rooms = new Map();
  const wallets = new Wallets(cfg.walletFile);
  const queues = new Map(QUICK_STAKES.map((s) => [s, []]));
  const createLimiter = new S.KeyedLimiter(10, 0.1, 10000);
  const joinLimiter = new S.KeyedLimiter(20, 0.5, 10000);
  const connPerIp = new Map();
  const rng = cfg.rng || (() => crypto.randomInt(1, G.DICE_SIDES + 1));

  function send(res, status, headers, body) {
    res.writeHead(status, { ...S.SECURITY_HEADERS, ...headers });
    res.end(body);
  }

  const server = http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { Allow: "GET, HEAD" }, "");
    let pathname;
    try {
      pathname = new URL(req.url, "http://local").pathname;
    } catch {
      return send(res, 400, {}, "");
    }
    if (pathname === "/healthz") return send(res, 200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }, "ok");
    if (pathname === "/config") return send(res, 200, { "Content-Type": "application/json", "Cache-Control": "no-store" }, configBody);
    const f = files.get(pathname);
    if (!f) return send(res, 404, { "Content-Type": "text/plain" }, "Not found");
    if (req.headers["if-none-match"] === f.etag) return send(res, 304, { ETag: f.etag }, "");
    const gz = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
    const headers = { "Content-Type": f.type, ETag: f.etag, "Cache-Control": f.cache, Vary: "Accept-Encoding" };
    if (gz) headers["Content-Encoding"] = "gzip";
    send(res, 200, headers, req.method === "HEAD" ? "" : gz ? f.gzip : f.body);
  });

  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (cfg.allowedOrigins.includes(origin)) return true;
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      return false;
    }
    return host === req.headers.host || host === req.headers["x-forwarded-host"];
  }

  const io = new Server(server, {
    maxHttpBufferSize: 64 * 1024,
    pingInterval: 10 * SECOND,
    pingTimeout: 8 * SECOND,
    connectTimeout: 10 * SECOND,
    perMessageDeflate: false,
    allowRequest: (req, cb) => {
      if (!originAllowed(req)) return cb("origin", false);
      const ip = S.clientIp(req, cfg.trustProxy);
      if ((connPerIp.get(ip) || 0) >= cfg.maxConnPerIp) return cb("too many connections", false);
      cb(null, true);
    },
  });

  function newCode() {
    let code;
    do {
      code = Array.from({ length: ROOM_CODE_LEN }, () => ROOM_CODE_CHARS[crypto.randomInt(ROOM_CODE_CHARS.length)]).join("");
    } while (rooms.has(code));
    return code;
  }

  const humans = (game) => [...game.players.values()].filter((p) => !p.bot);

  function pushWallet(player) {
    if (player.bot || !player.sid) return;
    io.to(player.sid).emit("wallet", wallets.view(player.pid));
  }

  function broadcast(game) {
    game.seq++;
    game.lastActive = Date.now();
    io.to(game.code).emit("state", { ...G.publicState(game), now: Date.now() });
  }

  function clearTimer(game) {
    if (game.timer) clearTimeout(game.timer);
    game.timer = null;
  }

  function schedule(game) {
    clearTimer(game);
    game.turnDeadline = null;
    if (game.phase !== "playing" || game.busy) return;
    const p = G.playerByColor(game, game.turn);
    const wait = p && p.bot ? cfg.botMs : p && p.online ? cfg.turnMs : cfg.offlineTurnMs;
    if (!p || !p.bot) game.turnDeadline = Date.now() + wait;
    game.timer = setTimeout(() => autoPlay(game), wait);
  }

  function autoPlay(game) {
    game.timer = null;
    if (game.phase !== "playing") return;
    if (!game.rolled) return doRoll(game, game.turn);
    const idx = G.bestMove(game, game.turn);
    if (idx !== null) doMove(game, game.turn, idx);
  }

  function later(game, ms, fn) {
    clearTimer(game);
    game.busy = true;
    game.turnDeadline = null;
    game.timer = setTimeout(() => {
      game.timer = null;
      game.busy = false;
      if (rooms.get(game.code) !== game || game.phase !== "playing") return;
      fn();
    }, ms);
  }

  function doRoll(game, color) {
    const r = G.roll(game, color, rng);
    if (!r) return;
    const bot = G.playerByColor(game, color).bot;
    if (r.pass) {
      later(game, cfg.passMs, () => {
        G.pass(game);
        schedule(game);
        broadcast(game);
      });
    } else if (r.autoMove !== null) {
      later(game, cfg.autoMoveMs, () => doMove(game, color, r.autoMove));
    } else if (bot) {
      later(game, cfg.autoMoveMs, () => doMove(game, color, G.bestMove(game, color)));
    } else {
      schedule(game);
    }
    broadcast(game);
  }

  function payout(game) {
    if (game.paidOut || !game.winners.length) return;
    game.paidOut = true;
    const winner = G.playerByColor(game, game.winners[0]);
    if (winner && !winner.bot) {
      if (game.pot > 0) wallets.credit(winner.pid, game.pot);
      wallets.record(winner.pid, { won: 1, coins: game.pot });
    }
    humans(game).forEach(pushWallet);
  }

  function botReact(game) {
    const a = game.action;
    if (!a || !a.captured || !a.captured.length) return;
    const mover = G.playerByColor(game, a.color);
    const victim = G.playerByColor(game, a.captured[0].color);
    const react = (p, ids) => {
      if (!p || !p.bot) return;
      const id = ids[crypto.randomInt(ids.length)];
      const t = setTimeout(() => io.to(game.code).emit("emote", { color: p.color, id }), cfg.autoMoveMs);
      t.unref();
    };
    react(mover, ["laugh", "cool", "fire"]);
    react(victim, ["angry", "cry", "revenge"]);
  }

  function doMove(game, color, idx) {
    if (!G.move(game, color, idx)) return;
    botReact(game);
    if (game.phase === "over") {
      clearTimer(game);
      payout(game);
    }
    schedule(game);
    broadcast(game);
  }

  function startGame(game) {
    if (game.phase !== "lobby" || G.seatedColors(game).length < 2) return "Need at least 2 players";
    const broke = humans(game).filter((p) => !wallets.canPay(p.pid, game.stake));
    if (broke.length) return `${broke.map((p) => p.name).join(", ")} doesn't have ${game.stake} coins`;
    if (!G.start(game, game.hostPid)) return "Could not start";
    humans(game).forEach((p) => {
      wallets.pay(p.pid, game.stake);
      wallets.record(p.pid, { played: 1 });
    });
    game.pot = game.stake * game.players.size;
    humans(game).forEach(pushWallet);
    schedule(game);
    broadcast(game);
    return null;
  }

  function leaveQueue(socketId) {
    for (const q of queues.values()) {
      const i = q.findIndex((e) => e.sid === socketId);
      if (i >= 0) q.splice(i, 1);
    }
  }

  function makeMatch(stake, entries, botCount) {
    const code = newCode();
    const game = G.createGame(code, { stake, isPublic: true });
    game.lastActive = Date.now();
    rooms.set(code, game);
    entries.forEach((e) => G.addPlayer(game, e.pid, e.name));
    const names = [...BOT_NAMES].sort(() => crypto.randomInt(3) - 1);
    for (let i = 0; i < botCount; i++) {
      const { player } = G.addPlayer(game, `bot-${crypto.randomUUID()}`, `🤖 ${names[i]}`, true);
      player.skin = C.SKINS[crypto.randomInt(C.SKINS.length)].id;
    }
    entries.forEach((e) => io.to(e.sid).emit("matched", { code }));
    game.matchTimer = setTimeout(() => {
      if (rooms.get(code) !== game || game.phase !== "lobby") return;
      humans(game).filter((p) => !p.online).forEach((p) => G.removePlayer(game, p.pid));
      if (humans(game).length) startGame(game);
      broadcast(game);
    }, cfg.matchStartMs);
    game.matchTimer.unref();
  }

  function matchTick() {
    const now = Date.now();
    for (const [stake, q] of queues) {
      if (rooms.size >= cfg.maxRooms) return;
      while (q.length >= G.MAX_PLAYERS) makeMatch(stake, q.splice(0, G.MAX_PLAYERS), 0);
      if (!q.length) continue;
      const waited = now - q[0].since;
      if (q.length >= 2 && waited >= cfg.quickWaitMs) makeMatch(stake, q.splice(0), 0);
      else if (q.length === 1 && waited >= cfg.botFillMs) makeMatch(stake, q.splice(0), G.MAX_PLAYERS - 1);
    }
  }
  const matcher = setInterval(matchTick, cfg.matchTickMs);
  matcher.unref();

  function sweep() {
    const now = Date.now();
    for (const [code, game] of rooms) {
      const anyOnline = humans(game).some((p) => p.online);
      if (!anyOnline && now - game.lastActive > cfg.roomIdleMs) {
        clearTimer(game);
        rooms.delete(code);
      }
    }
  }
  const sweeper = setInterval(sweep, cfg.sweepMs);
  sweeper.unref();

  io.on("connection", (socket) => {
    const ip = S.clientIp(socket.request, cfg.trustProxy);
    connPerIp.set(ip, (connPerIp.get(ip) || 0) + 1);
    const actions = new S.TokenBucket(30, 15);
    const signals = new S.TokenBucket(300, 60);
    const emotes = new S.TokenBucket(3, 0.5);
    let game = null;
    let me = null;
    let walletPid = null;

    const on = (event, handler, bucket = actions) => {
      socket.on(event, (...args) => {
        const ack = typeof args[args.length - 1] === "function" ? args.pop() : null;
        if (!bucket.take()) return ack && ack({ error: "Slow down" });
        try {
          handler(args[0], ack || (() => {}));
        } catch (err) {
          console.error(`handler ${event} failed`, err);
        }
      });
    };

    on("hello", (payload, ack) => {
      const pid = S.cleanPid(payload && payload.pid);
      if (!pid) return ack({ error: "Invalid id" });
      walletPid = pid;
      ack({ ...wallets.view(pid), catalog: { skins: C.SKINS, emotes: C.EMOTES } });
    });

    on("buy", (id, ack) => {
      if (!walletPid || typeof id !== "string" || !C.SKIN_IDS.has(id)) return ack({ error: "Unknown item" });
      const err = wallets.buy(walletPid, id, C.priceOf(id));
      if (err) return ack({ error: err, ...wallets.view(walletPid) });
      syncSkin();
      ack(wallets.view(walletPid));
    });

    on("equip", (id, ack) => {
      if (!walletPid || typeof id !== "string" || !wallets.equip(walletPid, id)) return ack({ error: "Not owned" });
      syncSkin();
      ack(wallets.view(walletPid));
    });

    function syncSkin() {
      if (!inGame() || me.pid !== walletPid) return;
      me.skin = wallets.get(walletPid).skin;
      broadcast(game);
    }

    on(
      "emote",
      (id) => {
        if (!inGame() || typeof id !== "string" || !C.EMOTE_IDS.has(id)) return;
        io.to(game.code).emit("emote", { color: me.color, id });
      },
      emotes
    );

    on("bonus", (_, ack) => {
      if (!walletPid) return ack({ error: "Say hello first" });
      if (!wallets.claimBonus(walletPid)) return ack({ error: "Bonus not ready yet", ...wallets.view(walletPid) });
      ack(wallets.view(walletPid));
    });

    on("create", (payload, ack) => {
      if (!createLimiter.take(ip)) return ack({ error: "Too many rooms created, wait a minute" });
      if (rooms.size >= cfg.maxRooms) return ack({ error: "Server busy, try later" });
      const stake = payload && FRIEND_STAKES.includes(payload.stake) ? payload.stake : 0;
      if (walletPid && !wallets.canPay(walletPid, stake)) return ack({ error: `You need ${stake} coins for this table` });
      const code = newCode();
      const g = G.createGame(code, { stake });
      g.lastActive = Date.now();
      rooms.set(code, g);
      ack({ code });
    });

    on("quick", (payload, ack) => {
      const p = payload || {};
      const pid = S.cleanPid(p.pid);
      const name = S.cleanName(p.name);
      if (!pid || !name || !QUICK_STAKES.includes(p.stake)) return ack({ error: "Invalid request" });
      if (!wallets.canPay(pid, p.stake)) return ack({ error: `You need ${p.stake} coins for this table` });
      if (game) leave();
      leaveQueue(socket.id);
      for (const q of queues.values()) {
        const i = q.findIndex((e) => e.pid === pid);
        if (i >= 0) q.splice(i, 1);
      }
      walletPid = pid;
      const q = queues.get(p.stake);
      q.push({ sid: socket.id, pid, name, since: Date.now() });
      ack({ queued: true, waiting: q.length });
    });

    on("quick-cancel", (_, ack) => {
      leaveQueue(socket.id);
      ack({ ok: true });
    });

    on("join", (payload, ack) => {
      if (!joinLimiter.take(ip)) return ack({ error: "Too many attempts, wait a minute" });
      const p = payload || {};
      const code = S.cleanCode(p.code);
      const pid = S.cleanPid(p.pid);
      const name = S.cleanName(p.name);
      if (!code || !pid || !name) return ack({ error: "Invalid name or room code" });
      const g = rooms.get(code);
      if (!g) return ack({ error: "Room not found" });
      if (!g.players.has(pid) && g.isPublic) return ack({ error: "This is a matchmaking room" });
      if (!g.players.has(pid) && !wallets.canPay(pid, g.stake)) return ack({ error: `You need ${g.stake} coins for this table` });
      if (game && game !== g) leave();
      leaveQueue(socket.id);
      const res = G.addPlayer(g, pid, name);
      if (res.error) return ack({ error: res.error });
      const player = res.player;
      if (player.sid && player.sid !== socket.id) {
        const old = io.sockets.sockets.get(player.sid);
        if (old) {
          old.emit("kicked", "Opened in another tab");
          old.disconnect(true);
        }
      }
      player.sid = socket.id;
      player.skin = wallets.get(pid).skin;
      game = g;
      me = player;
      walletPid = pid;
      G.setOnline(g, pid, true);
      socket.join(code);
      const peers = humans(g).filter((x) => x.online && x.sid !== socket.id).map((x) => x.sid);
      ack({ ok: true, color: player.color, peers, ...wallets.view(pid) });
      if (g.isPublic && g.phase === "lobby" && humans(g).every((x) => x.online)) {
        clearTimeout(g.matchTimer);
        startGame(g);
        return;
      }
      if (g.phase === "playing" && !g.busy) schedule(g);
      broadcast(g);
    });

    const inGame = () => game && me && me.sid === socket.id && rooms.get(game.code) === game;

    on("start", (_, ack) => {
      if (!inGame() || me.pid !== game.hostPid || game.isPublic) return;
      const err = startGame(game);
      if (err) ack({ error: err });
    });

    on("restart", () => {
      if (!inGame() || me.pid !== game.hostPid || game.phase !== "over" || game.isPublic) return;
      clearTimer(game);
      const fresh = G.resetGame(game);
      fresh.lastActive = Date.now();
      rooms.set(game.code, fresh);
      game = fresh;
      broadcast(fresh);
    });

    on("roll", () => {
      if (!inGame() || game.busy) return;
      doRoll(game, me.color);
    });

    on("move", (idx) => {
      if (!inGame() || game.busy || !Number.isInteger(idx)) return;
      doMove(game, me.color, idx);
    });

    on("media", (m) => {
      if (!inGame() || !m || typeof m !== "object") return;
      me.media = { audio: m.audio === true, video: m.video === true };
      broadcast(game);
    });

    on(
      "signal",
      (payload) => {
        if (!inGame() || !payload || typeof payload.to !== "string") return;
        const target = humans(game).find((p) => p.online && p.sid === payload.to);
        if (!target || target === me) return;
        const data = S.cleanSignal(payload.data);
        if (!data) return;
        io.to(target.sid).emit("signal", { from: socket.id, data });
      },
      signals
    );

    function leave() {
      if (!game || !me || me.sid !== socket.id) return;
      const g = game;
      socket.leave(g.code);
      io.to(g.code).emit("peer-left", socket.id);
      if (!G.removePlayer(g, me.pid)) {
        me.sid = null;
        G.setOnline(g, me.pid, false);
      }
      if (g.phase === "playing" && !g.busy) schedule(g);
      broadcast(g);
      game = null;
      me = null;
    }

    on("leave", (_, ack) => {
      leave();
      ack({ ok: true });
    });

    socket.on("disconnect", () => {
      leaveQueue(socket.id);
      const n = (connPerIp.get(ip) || 1) - 1;
      if (n <= 0) connPerIp.delete(ip);
      else connPerIp.set(ip, n);
      if (!game || !me || me.sid !== socket.id) return;
      const g = game;
      io.to(g.code).emit("peer-left", socket.id);
      G.setOnline(g, me.pid, false);
      if (g.phase === "playing" && !g.busy) schedule(g);
      broadcast(g);
    });
  });

  function close() {
    clearInterval(sweeper);
    clearInterval(matcher);
    for (const g of rooms.values()) {
      clearTimer(g);
      clearTimeout(g.matchTimer);
    }
    wallets.flush();
    io.close();
    server.close();
  }

  return { server, io, rooms, wallets, queues, close };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const app = createApp();
  app.server.listen(port, () => console.log(`Ludo Live on http://localhost:${port}`));
  const shutdown = () => {
    app.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

module.exports = { createApp };
