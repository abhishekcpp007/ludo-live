"use strict";

const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;
const PID_RE = /^[A-Za-z0-9-]{16,64}$/;
const NAME_MAX = 16;
const SDP_MAX = 16 * 1024;
const CANDIDATE_MAX = 1024;
const MID_MAX = 64;

function cleanName(raw) {
  if (typeof raw !== "string") return null;
  const name = raw
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...name].slice(0, NAME_MAX).join("");
  return chars.length ? chars : null;
}

function cleanCode(raw) {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return ROOM_CODE_RE.test(code) ? code : null;
}

function cleanPid(raw) {
  return typeof raw === "string" && PID_RE.test(raw) ? raw : null;
}

function cleanSignal(data) {
  if (!data || typeof data !== "object") return null;
  if (data.sdp && typeof data.sdp === "object") {
    const { type, sdp } = data.sdp;
    if ((type !== "offer" && type !== "answer") || typeof sdp !== "string" || sdp.length > SDP_MAX) return null;
    return { sdp: { type, sdp } };
  }
  if (data.candidate && typeof data.candidate === "object") {
    const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = data.candidate;
    if (typeof candidate !== "string" || candidate.length > CANDIDATE_MAX) return null;
    const out = { candidate };
    if (typeof sdpMid === "string" && sdpMid.length <= MID_MAX) out.sdpMid = sdpMid;
    if (Number.isInteger(sdpMLineIndex) && sdpMLineIndex >= 0 && sdpMLineIndex < MID_MAX) out.sdpMLineIndex = sdpMLineIndex;
    if (typeof usernameFragment === "string" && usernameFragment.length <= MID_MAX) out.usernameFragment = usernameFragment;
    return { candidate: out };
  }
  return null;
}

class TokenBucket {
  constructor(capacity, refillPerSec, now = Date.now) {
    this.capacity = capacity;
    this.refillPerMs = refillPerSec / 1000;
    this.tokens = capacity;
    this.now = now;
    this.last = now();
  }

  take(cost = 1) {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + (t - this.last) * this.refillPerMs);
    this.last = t;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

class KeyedLimiter {
  constructor(capacity, refillPerSec, maxKeys) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.maxKeys = maxKeys;
    this.buckets = new Map();
  }

  take(key) {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value);
      b = new TokenBucket(this.capacity, this.refillPerSec);
      this.buckets.set(key, b);
    }
    return b.take();
  }
}

function clientIp(req, trustProxy) {
  if (trustProxy === "cloudflare" && typeof req.headers["cf-connecting-ip"] === "string") {
    return req.headers["cf-connecting-ip"];
  }
  if (trustProxy === "xff" && typeof req.headers["x-forwarded-for"] === "string") {
    return req.headers["x-forwarded-for"].split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(self), microphone=(self), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

module.exports = {
  cleanName,
  cleanCode,
  cleanPid,
  cleanSignal,
  TokenBucket,
  KeyedLimiter,
  clientIp,
  SECURITY_HEADERS,
  ROOM_CODE_RE,
};
