"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { io: ioc } = require("socket.io-client");
const { createApp } = require("../src/server");
const { Wallets, START_COINS, BONUS_COINS } = require("../src/wallet");

const FAST = {
  turnMs: 5,
  offlineTurnMs: 5,
  botMs: 2,
  autoMoveMs: 2,
  passMs: 2,
  quickWaitMs: 150,
  botFillMs: 250,
  matchStartMs: 400,
  matchTickMs: 30,
};
const SLOW_TURNS = { ...FAST, turnMs: 60000 };
const GAME_TIMEOUT_MS = 20000;

async function boot(opts = {}) {
  const app = createApp(opts);
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const sockets = [];
  const client = (extra = {}) =>
    new Promise((resolve, reject) => {
      const s = ioc(url, { forceNew: true, transports: ["websocket"], reconnection: false, ...extra });
      sockets.push(s);
      s.once("connect", () => resolve(s));
      s.once("connect_error", reject);
    });
  const stop = () => {
    sockets.forEach((s) => s.disconnect());
    app.close();
  };
  return { app, url, client, stop };
}

const pid = () => crypto.randomUUID();
const call = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));
const once = (s, ev, pred = () => true, ms = GAME_TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${ev}`)), ms);
    const h = (v) => {
      if (!pred(v)) return;
      clearTimeout(t);
      s.off(ev, h);
      resolve(v);
    };
    s.on(ev, h);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(url, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function room(env, n, stake = 0) {
  const players = [];
  for (let i = 0; i < n; i++) {
    const s = await env.client();
    const id = pid();
    await call(s, "hello", { pid: id });
    players.push({ s, id });
  }
  const { code } = await call(players[0].s, "create", { stake });
  for (let i = 0; i < n; i++) {
    const res = await call(players[i].s, "join", { code, name: `P${i}`, pid: players[i].id });
    assert.ok(res.ok, JSON.stringify(res));
    players[i].color = res.color;
  }
  return { code, players };
}

test("http: security headers, gzip, etag and no path traversal", async () => {
  const env = await boot(SLOW_TURNS);
  try {
    const home = await get(`${env.url}/`, { "Accept-Encoding": "gzip" });
    assert.equal(home.status, 200);
    assert.match(home.headers["content-security-policy"], /default-src 'self'/);
    assert.match(home.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.equal(home.headers["x-content-type-options"], "nosniff");
    assert.equal(home.headers["x-frame-options"], "DENY");
    assert.equal(home.headers["content-encoding"], "gzip");
    const again = await get(`${env.url}/`, { "If-None-Match": home.headers.etag });
    assert.equal(again.status, 304);
    for (const p of ["/../package.json", "/%2e%2e/package.json", "/src/server.js", "/package.json", "/.env", "/data/wallets.json"]) {
      assert.equal((await get(`${env.url}${p}`)).status, 404, p);
    }
    assert.equal((await get(`${env.url}/`, {}, "POST")).status, 405);
    assert.equal((await get(`${env.url}/healthz`)).body.toString(), "ok");
    const cfg = JSON.parse((await get(`${env.url}/config`)).body);
    assert.ok(Array.isArray(cfg.iceServers));
    assert.equal((await get(`${env.url}/socket.io/socket.io.min.js`)).status, 200);
  } finally {
    env.stop();
  }
});

test("socket: cross-site origins are refused", async () => {
  const env = await boot(SLOW_TURNS);
  try {
    await assert.rejects(env.client({ extraHeaders: { Origin: "https://evil.example" } }));
  } finally {
    env.stop();
  }
});

test("join validates input, hides pids and caps the room at four", async () => {
  const env = await boot(SLOW_TURNS);
  try {
    const { code, players } = await room(env, 4);
    const s = await env.client();
    assert.match((await call(s, "join", { code, name: "X", pid: pid() })).error, /full/);
    assert.match((await call(s, "join", { code: "../..", name: "X", pid: pid() })).error, /Invalid/);
    assert.match((await call(s, "join", { code, name: "", pid: pid() })).error, /Invalid/);
    assert.match((await call(s, "join", { code, name: "X", pid: "short" })).error, /Invalid/);
    assert.match((await call(s, "join", { code, name: { a: 1 }, pid: pid() })).error, /Invalid/);
    assert.match((await call(s, "join", null)).error, /Invalid/);
    const st = await new Promise((r) => {
      players[0].s.once("state", r);
      players[0].s.emit("media", { audio: true, video: false });
    });
    const json = JSON.stringify(st);
    players.forEach((p) => assert.ok(!json.includes(p.id), "pid leaked"));
  } finally {
    env.stop();
  }
});

test("only the host starts, only the current player rolls", async () => {
  const env = await boot(SLOW_TURNS);
  try {
    const { players } = await room(env, 2);
    const [host, guest] = players;
    guest.s.emit("start");
    await sleep(100);
    const started = once(host.s, "state", (st) => st.phase === "playing");
    host.s.emit("start");
    const st = await started;
    assert.equal(st.turn, "red");
    guest.s.emit("roll");
    guest.s.emit("move", 0);
    host.s.emit("move", "0");
    host.s.emit("move", { idx: 0 });
    await sleep(100);
    const rolled = once(host.s, "state", (x) => x.action && x.action.type === "roll");
    host.s.emit("roll");
    const r = await rolled;
    assert.equal(r.action.color, "red");
    assert.ok(r.dice >= 1 && r.dice <= 6);
  } finally {
    env.stop();
  }
});

test("stakes are charged at start and the winner takes the pot", async () => {
  const env = await boot(FAST);
  try {
    const { players } = await room(env, 2, 500);
    const walletEvents = players.map((p) => once(p.s, "wallet", (w) => w.coins === START_COINS - 500));
    const over = once(players[0].s, "state", (st) => st.phase === "over");
    players[0].s.emit("start");
    await Promise.all(walletEvents);
    const st = await over;
    assert.equal(st.pot, 1000);
    const winner = players.find((p) => p.color === st.winners[0]);
    const loser = players.find((p) => p !== winner);
    assert.equal(env.app.wallets.get(winner.id).coins, START_COINS + 500);
    assert.equal(env.app.wallets.get(loser.id).coins, START_COINS - 500);
    assert.equal(env.app.wallets.get(winner.id).wins, 1);
    assert.equal(env.app.wallets.get(loser.id).games, 1);
  } finally {
    env.stop();
  }
});

test("cannot join a table you cannot afford", async () => {
  const env = await boot(SLOW_TURNS);
  try {
    const s = await env.client();
    const id = pid();
    await call(s, "hello", { pid: id });
    assert.match((await call(s, "create", { stake: 2500 })).error, /2500/);
    const t = await env.client();
    const tid = pid();
    await call(t, "hello", { pid: tid });
    env.app.wallets.credit(tid, 5000);
    const { code } = await call(t, "create", { stake: 2500 });
    assert.match((await call(s, "join", { code, name: "Poor", pid: id })).error, /2500/);
  } finally {
    env.stop();
  }
});

test("shop: buy, equip and refuse bad purchases", async () => {
  const env = await boot(SLOW_TURNS);
  try {
    const s = await env.client();
    const id = pid();
    const hello = await call(s, "hello", { pid: id });
    assert.ok(hello.catalog.skins.length > 5);
    let w = await call(s, "buy", "glass");
    assert.equal(w.coins, START_COINS - 300);
    assert.ok(w.owned.includes("glass"));
    assert.equal(w.skin, "glass");
    assert.match((await call(s, "buy", "glass")).error, /owned/);
    assert.match((await call(s, "buy", "diamond")).error, /Not enough/);
    assert.match((await call(s, "buy", "__proto__")).error, /Unknown/);
    assert.match((await call(s, "buy", { id: "glass" })).error, /Unknown/);
    assert.match((await call(s, "equip", "gold")).error, /Not owned/);
    w = await call(s, "equip", "classic");
    assert.equal(w.skin, "classic");
  } finally {
    env.stop();
  }
});

test("daily bonus works once", async () => {
  const env = await boot(SLOW_TURNS);
  try {
    const s = await env.client();
    await call(s, "hello", { pid: pid() });
    const w = await call(s, "bonus");
    assert.equal(w.coins, START_COINS + BONUS_COINS);
    assert.match((await call(s, "bonus")).error, /not ready/);
  } finally {
    env.stop();
  }
});

test("equipped skin shows up for everyone in the room", async () => {
  const env = await boot(SLOW_TURNS);
  try {
    const { players } = await room(env, 2);
    const seen = once(players[1].s, "state", (st) => st.players.some((p) => p.color === "red" && p.skin === "neon"));
    await call(players[0].s, "buy", "neon");
    await seen;
  } finally {
    env.stop();
  }
});

test("quick match pairs two strangers and starts automatically", async () => {
  const env = await boot(SLOW_TURNS);
  try {
    const a = await env.client();
    const b = await env.client();
    const ida = pid();
    const idb = pid();
    assert.match((await call(a, "quick", { pid: ida, name: "A", stake: 7 })).error, /Invalid/);
    const ma = once(a, "matched");
    const mb = once(b, "matched");
    assert.ok((await call(a, "quick", { pid: ida, name: "A", stake: 100 })).queued);
    assert.ok((await call(b, "quick", { pid: idb, name: "B", stake: 100 })).queued);
    const [{ code }, m2] = await Promise.all([ma, mb]);
    assert.equal(code, m2.code);
    const outsider = await env.client();
    assert.match((await call(outsider, "join", { code, name: "O", pid: pid() })).error, /matchmaking/);
    const playing = once(a, "state", (st) => st.phase === "playing");
    await call(a, "join", { code, name: "A", pid: ida });
    await call(b, "join", { code, name: "B", pid: idb });
    const st = await playing;
    assert.equal(st.isPublic, true);
    assert.equal(st.pot, 200);
    assert.equal(env.app.wallets.get(ida).coins, START_COINS - 100);
  } finally {
    env.stop();
  }
});

test("a lonely player gets bots and the game plays to the end", async () => {
  const env = await boot(FAST);
  try {
    const a = await env.client();
    const ida = pid();
    const matched = once(a, "matched");
    await call(a, "quick", { pid: ida, name: "Solo", stake: 100 });
    const { code } = await matched;
    const over = once(a, "state", (st) => st.phase === "over");
    const res = await call(a, "join", { code, name: "Solo", pid: ida });
    assert.ok(res.ok);
    const st = await over;
    assert.equal(st.players.filter((p) => p.bot).length, 3);
    assert.equal(st.winners.length, 4);
    assert.equal(st.pot, 400);
  } finally {
    env.stop();
  }
});

test("cancel removes you from the queue", async () => {
  const env = await boot(SLOW_TURNS);
  try {
    const a = await env.client();
    await call(a, "quick", { pid: pid(), name: "A", stake: 500 });
    assert.equal(env.app.queues.get(500).length, 1);
    await call(a, "quick-cancel");
    assert.equal(env.app.queues.get(500).length, 0);
  } finally {
    env.stop();
  }
});

test("webrtc signals only reach members of the same room and are sanitized", async () => {
  const env = await boot(SLOW_TURNS);
  try {
    const r1 = await room(env, 2);
    const r2 = await room(env, 1);
    const [a, b] = r1.players;
    const intruder = r2.players[0].s;
    const got = [];
    b.s.on("signal", (m) => got.push(m));
    intruder.emit("signal", { to: b.s.id, data: { sdp: { type: "offer", sdp: "v=0" } } });
    a.s.emit("signal", { to: b.s.id, data: { sdp: { type: "offer", sdp: "v=0", x: 1 }, junk: 2 } });
    a.s.emit("signal", { to: b.s.id, data: { sdp: { type: "bogus", sdp: "v=0" } } });
    a.s.emit("signal", { to: a.s.id, data: { sdp: { type: "offer", sdp: "v=0" } } });
    await sleep(150);
    assert.equal(got.length, 1);
    assert.equal(got[0].from, a.s.id);
    assert.deepEqual(got[0].data, { sdp: { type: "offer", sdp: "v=0" } });
  } finally {
    env.stop();
  }
});

test("emotes are whitelisted and rate limited", async () => {
  const env = await boot(SLOW_TURNS);
  try {
    const { players } = await room(env, 2);
    const got = [];
    players[1].s.on("emote", (e) => got.push(e));
    players[0].s.emit("emote", "<script>");
    for (let i = 0; i < 10; i++) players[0].s.emit("emote", "clap");
    await sleep(200);
    assert.ok(got.length >= 1 && got.length <= 3, `got ${got.length}`);
    assert.ok(got.every((e) => e.id === "clap" && e.color === "red"));
  } finally {
    env.stop();
  }
});

test("join brute force is rate limited", async () => {
  const env = await boot(SLOW_TURNS);
  try {
    const s = await env.client();
    let limited = false;
    for (let i = 0; i < 30; i++) {
      const res = await call(s, "join", { code: "ZZZZZ", name: "X", pid: pid() });
      if (/Too many|Slow down/.test(res.error)) limited = true;
    }
    assert.ok(limited);
  } finally {
    env.stop();
  }
});

test("disconnected player's turn is auto-played and seat survives a rejoin", async () => {
  const env = await boot({ ...SLOW_TURNS, offlineTurnMs: 20 });
  try {
    const { code, players } = await room(env, 2);
    const [host, guest] = players;
    host.s.emit("start");
    await once(guest.s, "state", (st) => st.phase === "playing");
    host.s.disconnect();
    await once(guest.s, "state", (st) => st.turn === "green");
    const back = await env.client();
    const res = await call(back, "join", { code, name: "P0", pid: host.id });
    assert.equal(res.color, "red");
  } finally {
    env.stop();
  }
});

test("wallets persist to disk", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ludo-"));
  const file = path.join(dir, "wallets.json");
  const w = new Wallets(file);
  w.credit("someone-xxxxxxxxxxxx", 250);
  w.buy("someone-xxxxxxxxxxxx", "glass", 300);
  w.flush();
  const again = new Wallets(file);
  assert.equal(again.get("someone-xxxxxxxxxxxx").coins, START_COINS + 250 - 300);
  assert.equal(again.get("someone-xxxxxxxxxxxx").skin, "glass");
  fs.writeFileSync(file, "{not json");
  assert.equal(new Wallets(file).map.size, 0);
  fs.rmSync(dir, { recursive: true });
});
