"use strict";

const fs = require("fs");
const path = require("path");

const START_COINS = 1000;
const BONUS_COINS = 500;
const BONUS_EVERY_MS = 24 * 60 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 2000;
const MAX_WALLETS = 200000;
const DEFAULT_SKIN = "classic";

function blank() {
  return { coins: START_COINS, lastBonus: 0, owned: [DEFAULT_SKIN], skin: DEFAULT_SKIN, games: 0, wins: 0, won: 0 };
}

class Wallets {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    this.timer = null;
    if (file) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        for (const [pid, w] of Object.entries(raw)) {
          if (!Number.isSafeInteger(w.coins) || w.coins < 0) continue;
          const owned = Array.isArray(w.owned) ? w.owned.filter((x) => typeof x === "string") : [DEFAULT_SKIN];
          this.map.set(pid, {
            ...blank(),
            coins: w.coins,
            lastBonus: Number(w.lastBonus) || 0,
            owned: owned.includes(DEFAULT_SKIN) ? owned : [DEFAULT_SKIN, ...owned],
            skin: owned.includes(w.skin) ? w.skin : DEFAULT_SKIN,
            games: Number(w.games) || 0,
            wins: Number(w.wins) || 0,
            won: Number(w.won) || 0,
          });
        }
      } catch {}
    }
  }

  get(pid) {
    let w = this.map.get(pid);
    if (!w) {
      if (this.map.size >= MAX_WALLETS) this.map.delete(this.map.keys().next().value);
      w = blank();
      this.map.set(pid, w);
      this.save();
    }
    return w;
  }

  view(pid, now = Date.now()) {
    const w = this.get(pid);
    return {
      coins: w.coins,
      bonusIn: Math.max(0, w.lastBonus + BONUS_EVERY_MS - now),
      owned: [...w.owned],
      skin: w.skin,
      stats: { games: w.games, wins: w.wins, won: w.won },
    };
  }

  claimBonus(pid, now = Date.now()) {
    const w = this.get(pid);
    if (now - w.lastBonus < BONUS_EVERY_MS) return false;
    w.coins += BONUS_COINS;
    w.lastBonus = now;
    this.save();
    return true;
  }

  canPay(pid, amount) {
    return this.get(pid).coins >= amount;
  }

  pay(pid, amount) {
    const w = this.get(pid);
    if (w.coins < amount) return false;
    w.coins -= amount;
    this.save();
    return true;
  }

  credit(pid, amount) {
    this.get(pid).coins += amount;
    this.save();
  }

  buy(pid, id, price) {
    const w = this.get(pid);
    if (w.owned.includes(id)) return "Already owned";
    if (w.coins < price) return "Not enough coins";
    w.coins -= price;
    w.owned.push(id);
    w.skin = id;
    this.save();
    return null;
  }

  equip(pid, id) {
    const w = this.get(pid);
    if (!w.owned.includes(id)) return false;
    w.skin = id;
    this.save();
    return true;
  }

  record(pid, { played = 0, won = 0, coins = 0 }) {
    const w = this.get(pid);
    w.games += played;
    w.wins += won;
    w.won += coins;
    this.save();
  }

  save() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, SAVE_DEBOUNCE_MS);
    this.timer.unref();
  }

  flush() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error("wallet save failed", err.message);
    }
  }
}

module.exports = { Wallets, START_COINS, BONUS_COINS };
