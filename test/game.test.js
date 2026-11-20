"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../src/game");

const { YARD, FINISH_STEP } = G;

function setup(n = 2) {
  const g = G.createGame("ABCDE", { stake: 100 });
  for (let i = 0; i < n; i++) {
    G.addPlayer(g, `pid-${i}-xxxxxxxxxxxxxxxx`, `P${i}`);
    G.setOnline(g, `pid-${i}-xxxxxxxxxxxxxxxx`, true);
  }
  G.start(g, g.hostPid);
  return g;
}
const dice = (...vals) => () => vals.shift();

test("seats players in color order and caps at four", () => {
  const g = G.createGame("ABCDE");
  const colors = [0, 1, 2, 3].map((i) => G.addPlayer(g, `p${i}`, `N${i}`).player.color);
  assert.deepEqual(colors, ["red", "green", "yellow", "blue"]);
  assert.match(G.addPlayer(g, "p5", "N5").error, /full/);
});

test("rejoining with the same pid keeps the seat", () => {
  const g = G.createGame("ABCDE");
  const a = G.addPlayer(g, "p1", "A").player;
  const b = G.addPlayer(g, "p1", "A").player;
  assert.equal(a, b);
  assert.equal(g.players.size, 1);
});

test("cannot start alone or as non-host", () => {
  const g = G.createGame("ABCDE");
  G.addPlayer(g, "p1", "A");
  assert.equal(G.start(g, "p1"), false);
  G.addPlayer(g, "p2", "B");
  assert.equal(G.start(g, "p2"), false);
  assert.equal(G.start(g, "p1"), true);
  assert.equal(g.turn, "red");
});

test("needs a six to leave the yard", () => {
  const g = setup();
  const r = G.roll(g, "red", dice(4));
  assert.equal(r.pass, true);
  assert.deepEqual(G.movable(g, "red", 4), []);
  const g2 = setup();
  const r2 = G.roll(g2, "red", dice(6));
  assert.equal(r2.pass, false);
  assert.equal(r2.autoMove, 0);
  G.move(g2, "red", 0);
  assert.equal(g2.tokens.red[0], 0);
  assert.equal(g2.turn, "red", "six gives another roll");
  assert.equal(g2.rolled, false);
});

test("only the current player can roll and only once", () => {
  const g = setup();
  assert.equal(G.roll(g, "green", dice(6)), null);
  assert.ok(G.roll(g, "red", dice(6)));
  assert.equal(G.roll(g, "red", dice(6)), null);
});

test("rejects illegal moves", () => {
  const g = setup();
  G.roll(g, "red", dice(3));
  assert.equal(G.move(g, "red", 0), null, "yard token cannot move on 3");
  g.tokens.red[1] = 10;
  g.rolled = true;
  assert.equal(G.move(g, "red", 7), null);
  assert.equal(G.move(g, "green", 1), null);
  assert.ok(G.move(g, "red", 1));
  assert.equal(g.tokens.red[1], 13);
});

test("captures send the opponent home and grant a bonus roll", () => {
  const g = setup();
  g.tokens.red[0] = 10;
  g.tokens.green[0] = 50;
  assert.equal(G.absCell("red", 14), G.absCell("green", 1));
  g.tokens.green[0] = 1;
  G.roll(g, "red", dice(4));
  const r = G.move(g, "red", 0);
  assert.equal(g.tokens.green[0], YARD);
  assert.equal(r.bonus, true);
  assert.equal(g.turn, "red");
  assert.equal(g.action.captured.length, 1);
});

test("no capture on a safe square", () => {
  const g = setup();
  g.tokens.red[0] = 5;
  g.tokens.green[0] = 47;
  assert.equal(G.absCell("red", 8), G.absCell("green", 47));
  G.roll(g, "red", dice(3));
  G.move(g, "red", 0);
  assert.equal(g.tokens.green[0], 47);
  assert.equal(g.turn, "green");
});

test("tokens in the home column cannot be captured", () => {
  const g = setup();
  g.tokens.green[0] = 53;
  g.tokens.red[0] = 10;
  assert.equal(G.absCell("red", 14), G.absCell("green", 53));
  G.roll(g, "red", dice(4));
  G.move(g, "red", 0);
  assert.equal(g.tokens.green[0], 53);
  assert.equal(g.action.captured.length, 0);
});

test("exact roll needed to finish", () => {
  const g = setup();
  g.tokens.red = [53, FINISH_STEP, FINISH_STEP, FINISH_STEP];
  assert.deepEqual(G.movable(g, "red", 4), []);
  assert.deepEqual(G.movable(g, "red", 3), [0]);
});

test("three sixes in a row forfeit the turn", () => {
  const g = setup();
  g.tokens.red[0] = 0;
  for (let i = 0; i < 2; i++) {
    G.roll(g, "red", dice(6));
    G.move(g, "red", 0);
  }
  const r = G.roll(g, "red", dice(6));
  assert.equal(r.pass, true);
  assert.equal(g.action.forfeit, true);
  G.pass(g);
  assert.equal(g.turn, "green");
});

test("finishing all tokens ends a two player game", () => {
  const g = setup();
  g.tokens.red = [55, FINISH_STEP, FINISH_STEP, FINISH_STEP];
  G.roll(g, "red", dice(1));
  const r = G.move(g, "red", 0);
  assert.equal(r.over, true);
  assert.equal(g.phase, "over");
  assert.deepEqual(g.winners, ["red", "green"]);
});

test("turn skips offline players", () => {
  const g = setup(3);
  G.setOnline(g, "pid-1-xxxxxxxxxxxxxxxx", false);
  G.roll(g, "red", dice(2));
  G.pass(g);
  assert.equal(g.turn, "yellow");
});

test("public state never leaks private ids", () => {
  const g = setup();
  const json = JSON.stringify(G.publicState(g));
  assert.ok(!json.includes("pid-0"));
  assert.ok(!json.includes("pid-1"));
});

test("bot prefers a capture over a plain move", () => {
  const g = setup();
  g.tokens.red = [10, 20, YARD, YARD];
  g.tokens.green[0] = 1;
  g.dice = 4;
  g.rolled = true;
  assert.equal(G.absCell("red", 14), G.absCell("green", 1));
  assert.equal(G.bestMove(g, "red"), 0);
});
