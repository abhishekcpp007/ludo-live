"use strict";

const SKINS = [
  { id: "classic", name: "Classic", price: 0 },
  { id: "glass", name: "Glass", price: 300 },
  { id: "neon", name: "Neon", price: 500 },
  { id: "smile", name: "Smiley", price: 700 },
  { id: "star", name: "Superstar", price: 900 },
  { id: "tiger", name: "Tiger", price: 1200 },
  { id: "rocket", name: "Rocket", price: 1500 },
  { id: "fire", name: "Fire", price: 2000 },
  { id: "ice", name: "Ice", price: 2000 },
  { id: "galaxy", name: "Galaxy", price: 3000 },
  { id: "gold", name: "Royal Gold", price: 4000 },
  { id: "diamond", name: "Diamond", price: 6000 },
];

const EMOTES = ["laugh", "clap", "fire", "angry", "cry", "cool", "wave", "party", "gg", "hurry", "oops", "luck", "saved", "revenge"];

const SKIN_IDS = new Set(SKINS.map((s) => s.id));
const EMOTE_IDS = new Set(EMOTES);
const priceOf = (id) => (SKINS.find((s) => s.id === id) || {}).price;

module.exports = { SKINS, EMOTES, SKIN_IDS, EMOTE_IDS, priceOf };
