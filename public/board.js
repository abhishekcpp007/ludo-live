const Board = (() => {
  const COLORS = ["red", "green", "yellow", "blue"];
  const HEX = { red: "#ef4444", green: "#22c55e", yellow: "#facc15", blue: "#3b82f6" };
  const DARK = { red: "#b91c1c", green: "#15803d", yellow: "#ca8a04", blue: "#1d4ed8" };
  const SIZE = 15;
  const YARD = -1;
  const LAST_TRACK_STEP = 50;
  const FINISH_STEP = 56;
  const START_OFFSET = { red: 0, green: 13, yellow: 26, blue: 39 };
  const SAFE = [0, 8, 13, 21, 26, 34, 39, 47];
  const YARD_ORIGIN = { red: [0, 0], green: [0, 9], yellow: [9, 9], blue: [9, 0] };
  const YARD_SPOTS = [[2, 2], [2, 4], [4, 2], [4, 4]];
  const FINISH_SPOT = { red: [7.5, 6.55], green: [6.55, 7.5], yellow: [7.5, 8.45], blue: [8.45, 7.5] };
  const HOP_MS = 120;
  const FLY_MS = 700;
  const FX_MS = 900;
  const BURST_COUNT = 14;
  const FAST_FORWARD_QUEUE = 2;

  const range = (a, b) => (a <= b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : Array.from({ length: a - b + 1 }, (_, i) => a - i));
  const TRACK = [
    ...range(1, 5).map((c) => [6, c]),
    ...range(5, 0).map((r) => [r, 6]),
    [0, 7],
    ...range(0, 5).map((r) => [r, 8]),
    ...range(9, 14).map((c) => [6, c]),
    [7, 14],
    ...range(14, 9).map((c) => [8, c]),
    ...range(9, 14).map((r) => [r, 8]),
    [14, 7],
    ...range(14, 9).map((r) => [r, 6]),
    ...range(5, 0).map((c) => [8, c]),
    [7, 0],
    [6, 0],
  ];
  const HOME_COL = {
    red: range(1, 5).map((c) => [7, c]),
    green: range(1, 5).map((r) => [r, 7]),
    yellow: range(13, 9).map((c) => [7, c]),
    blue: range(13, 9).map((r) => [r, 7]),
  };

  let layer = null;
  let fxLayer = null;
  let boardEl = null;
  const skins = {};
  const glows = {};
  let nameEls = {};
  let shown = null;
  let movableSet = new Set();
  let myColor = null;
  let onPick = () => {};
  let queue = Promise.resolve();
  let pending = 0;
  const els = {};

  function cellOf(color, step, idx) {
    if (step === YARD) {
      const [r0, c0] = YARD_ORIGIN[color];
      const [r, c] = YARD_SPOTS[idx];
      return { r: r0 + r, c: c0 + c, key: `y-${color}-${idx}` };
    }
    if (step === FINISH_STEP) {
      const [r, c] = FINISH_SPOT[color];
      return { r, c, key: `f-${color}` };
    }
    if (step > LAST_TRACK_STEP) {
      const [r, c] = HOME_COL[color][step - LAST_TRACK_STEP - 1];
      return { r: r + 0.5, c: c + 0.5, key: `h-${r}-${c}` };
    }
    const abs = (step + START_OFFSET[color]) % TRACK.length;
    const [r, c] = TRACK[abs];
    return { r: r + 0.5, c: c + 0.5, key: `t-${abs}` };
  }

  function draw(svg, tokenLayer) {
    layer = tokenLayer;
    boardEl = layer.parentElement;
    COLORS.forEach((color) => {
      const [yr, yc] = YARD_ORIGIN[color];
      const g = document.createElement("div");
      g.className = `yardGlow ${color}`;
      g.style.left = `${(yc / SIZE) * 100}%`;
      g.style.top = `${(yr / SIZE) * 100}%`;
      layer.parentElement.insertBefore(g, layer);
      glows[color] = g;
    });
    fxLayer = document.createElement("div");
    fxLayer.className = "fx";
    boardEl.appendChild(fxLayer);
    const setCell = () => boardEl.style.setProperty("--cell", `${boardEl.clientWidth / SIZE}px`);
    if (window.ResizeObserver) new ResizeObserver(setCell).observe(boardEl);
    setCell();
    const ns = "http://www.w3.org/2000/svg";
    const el = (tag, attrs, parent = svg) => {
      const n = document.createElementNS(ns, tag);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      parent.appendChild(n);
      return n;
    };
    const defs = el("defs", {});
    COLORS.forEach((color) => {
      const g = el("linearGradient", { id: `g-${color}`, x1: 0, y1: 0, x2: 1, y2: 1 }, defs);
      el("stop", { offset: "0", "stop-color": HEX[color] }, g);
      el("stop", { offset: "1", "stop-color": DARK[color] }, g);
    });
    el("rect", { x: 0, y: 0, width: SIZE, height: SIZE, rx: 0.35, class: "b-bg" });
    const cell = (r, c, cls, fill) => el("rect", { x: c + 0.04, y: r + 0.04, width: 0.92, height: 0.92, rx: 0.14, class: cls, ...(fill ? { fill } : {}) });

    TRACK.forEach(([r, c]) => cell(r, c, "b-cell"));
    COLORS.forEach((color) => {
      HOME_COL[color].forEach(([r, c]) => cell(r, c, "b-home", HEX[color]));
      const [sr, sc] = TRACK[START_OFFSET[color]];
      cell(sr, sc, "b-home", HEX[color]);
      const [yr, yc] = YARD_ORIGIN[color];
      el("rect", { x: yc + 0.08, y: yr + 0.08, width: 5.84, height: 5.84, rx: 0.5, fill: `url(#g-${color})` });
      el("rect", { x: yc + 1, y: yr + 1, width: 4, height: 4, rx: 0.5, class: "b-yard" });
      YARD_SPOTS.forEach(([r, c]) => el("circle", { cx: yc + c, cy: yr + r, r: 0.62, fill: HEX[color], opacity: 0.22 }));
      const t = el("text", { x: yc + 3, y: yr + 0.72, "text-anchor": "middle", class: "b-name" });
      nameEls[color] = t;
    });
    SAFE.forEach((i) => {
      const [r, c] = TRACK[i];
      const isStart = Object.values(START_OFFSET).includes(i);
      el("path", { d: star(c + 0.5, r + 0.5, 0.32, 0.14), class: isStart ? "b-star w" : "b-star" });
    });
    const tri = (pts, color) => el("polygon", { points: pts, fill: `url(#g-${color})` });
    tri("6,6 6,9 7.5,7.5", "red");
    tri("6,6 9,6 7.5,7.5", "green");
    tri("9,6 9,9 7.5,7.5", "yellow");
    tri("6,9 9,9 7.5,7.5", "blue");

    COLORS.forEach((color) => {
      for (let idx = 0; idx < 4; idx++) {
        const b = document.createElement("button");
        b.className = `tok ${color}`;
        b.type = "button";
        b.tabIndex = -1;
        b.setAttribute("aria-label", `${color} token ${idx + 1}`);
        b.innerHTML = '<span class="pawn"></span>';
        b.addEventListener("click", () => {
          if (b.classList.contains("can")) onPick(idx);
        });
        layer.appendChild(b);
        els[`${color}-${idx}`] = b;
      }
    });
  }

  function star(cx, cy, R, r) {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const a = (Math.PI / 5) * i - Math.PI / 2;
      const rad = i % 2 ? r : R;
      pts.push(`${(cx + rad * Math.cos(a)).toFixed(3)},${(cy + rad * Math.sin(a)).toFixed(3)}`);
    }
    return `M${pts.join("L")}Z`;
  }

  function setNames(players) {
    COLORS.forEach((c) => {
      const p = players.find((x) => x.color === c);
      nameEls[c].textContent = p ? p.name : "";
      const skin = p && p.skin ? p.skin : "classic";
      if (skins[c] === skin) return;
      skins[c] = skin;
      for (let i = 0; i < 4; i++) {
        const b = els[`${c}-${i}`];
        [...b.classList].filter((k) => k.startsWith("skin-")).forEach((k) => b.classList.remove(k));
        b.classList.add(`skin-${skin}`);
      }
    });
  }

  function burst(r, c, kind, color) {
    const wrap = document.createElement("div");
    wrap.className = `burst ${kind}`;
    wrap.style.left = `${(c / SIZE) * 100}%`;
    wrap.style.top = `${(r / SIZE) * 100}%`;
    wrap.style.setProperty("--bc", HEX[color] || "#fff");
    for (let i = 0; i < BURST_COUNT; i++) {
      const sp = document.createElement("i");
      const a = (2 * Math.PI * i) / BURST_COUNT;
      const dist = 1 + Math.random() * 0.9;
      sp.style.setProperty("--dx", (Math.cos(a) * dist).toFixed(3));
      sp.style.setProperty("--dy", (Math.sin(a) * dist).toFixed(3));
      wrap.appendChild(sp);
    }
    if (kind === "cut") {
      const t = document.createElement("b");
      t.textContent = "CUT!";
      wrap.appendChild(t);
    }
    fxLayer.appendChild(wrap);
    setTimeout(() => wrap.remove(), FX_MS);
  }

  function shake() {
    boardEl.classList.remove("shake");
    void boardEl.offsetWidth;
    boardEl.classList.add("shake");
  }

  function layout(moving) {
    const groups = new Map();
    COLORS.forEach((color) => {
      shown[color].forEach((step, idx) => {
        const pos = cellOf(color, step, idx);
        const key = moving === `${color}-${idx}` ? `m-${color}-${idx}` : pos.key;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ color, idx, pos });
      });
    });
    for (const group of groups.values()) {
      const n = group.length;
      group.forEach(({ color, idx, pos }, k) => {
        const spread = n > 1 ? 0.2 : 0;
        const a = (2 * Math.PI * k) / n - Math.PI / 4;
        const r = pos.r - 0.5 + spread * Math.sin(a);
        const c = pos.c - 0.5 + spread * Math.cos(a);
        const b = els[`${color}-${idx}`];
        b.style.transform = `translate3d(${c * 100}%, ${r * 100}%, 0)`;
        b.style.setProperty("--s", n > 1 ? 0.72 : 1);
        b.style.zIndex = String(10 + Math.round(r * 2));
        const can = color === myColor && movableSet.has(idx);
        b.classList.toggle("can", can);
        b.tabIndex = can ? 0 : -1;
      });
    }
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function apply(state, hooks) {
    const target = state.tokens;
    if (!shown) {
      shown = JSON.parse(JSON.stringify(target));
      layout();
      return;
    }
    const a = state.action;
    const fast = pending > FAST_FORWARD_QUEUE || document.hidden;
    if (!fast && a && a.type === "move" && shown[a.color][a.idx] === a.from && a.to !== a.from) {
      const key = `${a.color}-${a.idx}`;
      const start = a.from === YARD ? 0 : a.from + 1;
      els[key].classList.add("hop");
      for (let s = start; s <= a.to; s++) {
        shown[a.color][a.idx] = s;
        layout(s < a.to ? key : null);
        hooks.step && hooks.step();
        await wait(HOP_MS);
      }
      els[key].classList.remove("hop");
      const end = cellOf(a.color, a.to, a.idx);
      if (a.captured && a.captured.length) {
        burst(end.r, end.c, "cut", a.captured[0].color);
        shake();
        a.captured.forEach((cp) => {
          const el = els[`${cp.color}-${cp.idx}`];
          el.classList.add("fly");
          setTimeout(() => el.classList.remove("fly"), FLY_MS);
        });
        hooks.capture && hooks.capture();
      }
      if (a.home) {
        burst(end.r, end.c, "home", a.color);
        hooks.home && hooks.home();
      }
    }
    shown = JSON.parse(JSON.stringify(target));
    layout();
  }

  function render(state, me, pick, hooks = {}) {
    myColor = me;
    onPick = pick;
    movableSet = new Set(state.movable && state.turn === me ? state.movable : []);
    setNames(state.players);
    COLORS.forEach((c) => glows[c] && glows[c].classList.toggle("on", state.phase === "playing" && state.turn === c));
    pending++;
    queue = queue
      .then(() => apply(state, hooks))
      .catch(() => {})
      .finally(() => pending--);
    return queue;
  }

  function reset() {
    shown = null;
  }

  return { draw, render, reset, HEX, COLORS };
})();
