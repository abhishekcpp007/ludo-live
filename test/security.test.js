"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../src/security");

test("names are trimmed, capped and stripped of control characters", () => {
  assert.equal(S.cleanName("  Abhi  "), "Abhi");
  assert.equal(S.cleanName("a\u0000b‮c"), "abc");
  assert.equal([...S.cleanName("x".repeat(100))].length, 16);
  assert.equal(S.cleanName(""), null);
  assert.equal(S.cleanName("   "), null);
  assert.equal(S.cleanName({ toString: () => "x" }), null);
  assert.equal(S.cleanName("<img src=x onerror=alert(1)>"), "<img src=x onerr");
});

test("room codes must match the alphabet", () => {
  assert.equal(S.cleanCode("abcde"), "ABCDE");
  assert.equal(S.cleanCode("ABCD"), null);
  assert.equal(S.cleanCode("ABC0E"), null);
  assert.equal(S.cleanCode("../.."), null);
  assert.equal(S.cleanCode(12345), null);
});

test("pids must look random", () => {
  assert.ok(S.cleanPid("0b5c6d1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e"));
  assert.equal(S.cleanPid("short"), null);
  assert.equal(S.cleanPid("bad pid with spaces!!"), null);
  assert.equal(S.cleanPid(null), null);
});

test("signals keep only whitelisted fields", () => {
  const sdp = S.cleanSignal({ sdp: { type: "offer", sdp: "v=0", evil: 1 }, extra: true });
  assert.deepEqual(sdp, { sdp: { type: "offer", sdp: "v=0" } });
  assert.equal(S.cleanSignal({ sdp: { type: "rollback", sdp: "v=0" } }), null);
  assert.equal(S.cleanSignal({ sdp: { type: "offer", sdp: "x".repeat(20000) } }), null);
  const c = S.cleanSignal({ candidate: { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0, junk: "x" } });
  assert.deepEqual(c, { candidate: { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 } });
  assert.equal(S.cleanSignal("string"), null);
  assert.equal(S.cleanSignal(null), null);
});

test("token bucket refills over time", () => {
  let now = 0;
  const b = new S.TokenBucket(2, 1, () => now);
  assert.ok(b.take());
  assert.ok(b.take());
  assert.equal(b.take(), false);
  now = 1000;
  assert.ok(b.take());
  assert.equal(b.take(), false);
});

test("keyed limiter evicts old keys at the cap", () => {
  const l = new S.KeyedLimiter(1, 0, 2);
  assert.ok(l.take("a"));
  assert.ok(l.take("b"));
  assert.ok(l.take("c"));
  assert.equal(l.buckets.size, 2);
  assert.equal(l.take("c"), false);
});
