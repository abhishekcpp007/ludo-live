"use strict";

const COLORS = ["red", "green", "yellow", "blue"];
const TOKENS_PER_PLAYER = 4;
const TRACK_LEN = 52;
const LAST_TRACK_STEP = 50;
const FINISH_STEP = 56;
const YARD = -1;
const DICE_SIDES = 6;
const SIX = 6;
const MAX_SIXES = 3;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = COLORS.length;
const LOG_SIZE = 6;
const START_OFFSET = { red: 0, green: 13, yellow: 26, blue: 39 };
const SAFE_CELLS = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

function createGame(code, opts = {}) {
  return {
    code,
    stake: opts.stake || 0,
    pot: 0,
    isPublic: !!opts.isPublic,
    players: new Map(),
    hostPid: null,
    phase: "lobby",
    turn: null,
    dice: null,
    rolled: false,
    sixCount: 0,
    tokens: Object.fromEntries(COLORS.map((c) => [c, Array(TOKENS_PER_PLAYER).fill(YARD)])),
    winners: [],
    log: [],
    action: null,
    seq: 0,
    turnDeadline: null,
  };
}

function resetGame(game) {
  const fresh = createGame(game.code, { stake: game.stake, isPublic: game.isPublic });
  fresh.players = game.players;
  fresh.hostPid = game.hostPid;
  fresh.seq = game.seq;
  return fresh;
}

function absCell(color, step) {
  return (step + START_OFFSET[color]) % TRACK_LEN;
}

function playerByColor(game, color) {
  for (const p of game.players.values()) if (p.color === color) return p;
  return null;
}

function nameOf(game, color) {
  const p = playerByColor(game, color);
  return p ? p.name : color;
}

function seatedColors(game) {
  const used = new Set([...game.players.values()].map((p) => p.color));
  return COLORS.filter((c) => used.has(c));
}

function isFinished(game, color) {
  return game.tokens[color].every((s) => s === FINISH_STEP);
}

function movable(game, color, dice) {
  const out = [];
  game.tokens[color].forEach((s, i) => {
    if (s === YARD ? dice === SIX : s !== FINISH_STEP && s + dice <= FINISH_STEP) out.push(i);
  });
  return out;
}

function pushLog(game, text) {
  game.log.push(text);
  if (game.log.length > LOG_SIZE) game.log.shift();
}

function addPlayer(game, pid, name, bot = false) {
  const existing = game.players.get(pid);
  if (existing) return { player: existing };
  if (game.players.size >= MAX_PLAYERS) return { error: "Room is full (4 players)" };
  if (game.phase !== "lobby") return { error: "Game already started" };
  const taken = new Set([...game.players.values()].map((p) => p.color));
  const color = COLORS.find((c) => !taken.has(c));
  const player = { pid, name, color, sid: null, online: bot, bot, skin: "classic", media: { audio: false, video: false } };
  game.players.set(pid, player);
  if (!game.hostPid) game.hostPid = pid;
  pushLog(game, `${name} joined`);
  return { player };
}

function removePlayer(game, pid) {
  const p = game.players.get(pid);
  if (!p || game.phase !== "lobby") return false;
  game.players.delete(pid);
  if (game.hostPid === pid) {
    const next = game.players.values().next().value;
    game.hostPid = next ? next.pid : null;
  }
  pushLog(game, `${p.name} left`);
  return true;
}

function start(game, pid) {
  if (game.phase !== "lobby" || pid !== game.hostPid) return false;
  if (seatedColors(game).length < MIN_PLAYERS) return false;
  game.phase = "playing";
  game.turn = seatedColors(game)[0];
  game.action = { type: "start", color: game.turn };
  pushLog(game, `Game started, ${nameOf(game, game.turn)} goes first`);
  return true;
}

function advanceTurn(game) {
  game.rolled = false;
  game.sixCount = 0;
  const live = seatedColors(game).filter((c) => !isFinished(game, c));
  if (!live.length) return;
  const from = COLORS.indexOf(game.turn);
  let fallback = null;
  for (let k = 1; k <= COLORS.length; k++) {
    const c = COLORS[(from + k) % COLORS.length];
    if (!live.includes(c)) continue;
    if (playerByColor(game, c).online) {
      game.turn = c;
      return;
    }
    if (!fallback) fallback = c;
  }
  game.turn = fallback;
}

function finishIfOver(game) {
  const seated = seatedColors(game);
  const live = seated.filter((c) => !isFinished(game, c));
  if (live.length > 1 || seated.length < 2) return false;
  live.forEach((c) => game.winners.push(c));
  game.phase = "over";
  game.rolled = false;
  game.turnDeadline = null;
  pushLog(game, `Game over, ${nameOf(game, game.winners[0])} wins`);
  return true;
}

function roll(game, color, rng) {
  if (game.phase !== "playing" || game.turn !== color || game.rolled) return null;
  game.dice = rng();
  game.rolled = true;
  if (game.dice === SIX) game.sixCount++;
  const name = nameOf(game, color);
  game.action = { type: "roll", color, dice: game.dice };

  if (game.sixCount === MAX_SIXES) {
    pushLog(game, `${name} rolled three 6s, turn lost`);
    game.action.forfeit = true;
    return { pass: true };
  }
  const options = movable(game, color, game.dice);
  if (!options.length) {
    pushLog(game, `${name} rolled ${game.dice}, no moves`);
    return { pass: true };
  }
  pushLog(game, `${name} rolled ${game.dice}`);
  const distinct = new Set(options.map((i) => game.tokens[color][i]));
  return { pass: false, autoMove: distinct.size === 1 ? options[0] : null };
}

function move(game, color, idx) {
  if (game.phase !== "playing" || game.turn !== color || !game.rolled) return null;
  if (!movable(game, color, game.dice).includes(idx)) return null;
  const tokens = game.tokens[color];
  const name = nameOf(game, color);
  const from = tokens[idx];
  const to = from === YARD ? 0 : from + game.dice;
  tokens[idx] = to;
  let bonus = game.dice === SIX;
  const captured = [];

  if (to <= LAST_TRACK_STEP) {
    const cell = absCell(color, to);
    if (!SAFE_CELLS.has(cell)) {
      for (const other of COLORS) {
        if (other === color) continue;
        game.tokens[other].forEach((s, j) => {
          if (s !== YARD && s <= LAST_TRACK_STEP && absCell(other, s) === cell) {
            game.tokens[other][j] = YARD;
            captured.push({ color: other, idx: j, from: s });
          }
        });
      }
    }
  }

  game.action = { type: "move", color, idx, from, to, dice: game.dice, captured };
  if (captured.length) {
    bonus = true;
    pushLog(game, `${name} cut ${captured.map((c) => nameOf(game, c.color)).join(" & ")}`);
  } else if (to === FINISH_STEP) {
    pushLog(game, `${name} got a token home`);
  } else {
    pushLog(game, from === YARD ? `${name} opened a token` : `${name} moved ${game.dice}`);
  }

  if (to === FINISH_STEP) {
    bonus = true;
    game.action.home = true;
    if (isFinished(game, color)) {
      game.winners.push(color);
      game.action.finished = game.winners.length;
      pushLog(game, `${name} finished #${game.winners.length}`);
      bonus = false;
    }
  }

  if (finishIfOver(game)) return { over: true };
  if (bonus) {
    game.rolled = false;
  } else {
    advanceTurn(game);
  }
  return { bonus };
}

function pass(game) {
  if (game.phase !== "playing") return;
  advanceTurn(game);
}

function setOnline(game, pid, online) {
  const p = game.players.get(pid);
  if (!p) return;
  p.online = online;
  if (game.phase !== "playing") return;
  if (!online) {
    pushLog(game, `${p.name} disconnected`);
    if (finishIfOver(game)) return;
    if (game.turn === p.color) advanceTurn(game);
  }
}

function bestMove(game, color) {
  const options = movable(game, color, game.dice);
  if (!options.length) return null;
  const score = (i) => {
    const from = game.tokens[color][i];
    const to = from === YARD ? 0 : from + game.dice;
    if (to === FINISH_STEP) return 1000;
    let v = to;
    if (to <= LAST_TRACK_STEP) {
      const cell = absCell(color, to);
      if (SAFE_CELLS.has(cell)) v += 40;
      else {
        for (const other of COLORS) {
          if (other === color) continue;
          if (game.tokens[other].some((st) => st !== YARD && st <= LAST_TRACK_STEP && absCell(other, st) === cell)) v += 500;
        }
      }
    } else {
      v += 60;
    }
    if (from === YARD) v += 300;
    return v;
  };
  return options.reduce((best, i) => (score(i) > score(best) ? i : best), options[0]);
}

function publicState(game) {
  const playing = game.phase === "playing";
  return {
    code: game.code,
    seq: game.seq,
    players: [...game.players.values()].map((p) => ({
      sid: p.online ? p.sid : null,
      name: p.name,
      color: p.color,
      online: p.online,
      host: p.pid === game.hostPid,
      bot: p.bot,
      skin: p.skin,
      media: p.media,
    })),
    phase: game.phase,
    stake: game.stake,
    pot: game.pot,
    isPublic: game.isPublic,
    turn: game.turn,
    dice: game.dice,
    rolled: game.rolled,
    tokens: game.tokens,
    winners: game.winners,
    log: game.log,
    action: game.action,
    movable: playing && game.rolled ? movable(game, game.turn, game.dice) : [],
    turnDeadline: game.turnDeadline,
  };
}

module.exports = {
  COLORS,
  YARD,
  FINISH_STEP,
  LAST_TRACK_STEP,
  DICE_SIDES,
  SIX,
  MAX_PLAYERS,
  SAFE_CELLS,
  START_OFFSET,
  createGame,
  resetGame,
  addPlayer,
  removePlayer,
  start,
  roll,
  move,
  pass,
  movable,
  setOnline,
  advanceTurn,
  absCell,
  isFinished,
  playerByColor,
  publicState,
  bestMove,
  seatedColors,
};
