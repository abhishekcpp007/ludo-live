const Sound = (() => {
  let ctx = null;
  let muted = false;
  try {
    muted = localStorage.getItem("ludo-muted") === "1";
  } catch {}

  function context() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }

  function tone(freq, start, dur, type = "sine", gain = 0.12) {
    const c = context();
    if (!c || muted) return;
    const t = c.currentTime + start;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(c.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  function noise(start, dur, gain = 0.08) {
    const c = context();
    if (!c || muted) return;
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource();
    const g = c.createGain();
    const f = c.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.value = 1800;
    g.gain.value = gain;
    src.buffer = buf;
    src.connect(f).connect(g).connect(c.destination);
    src.start(c.currentTime + start);
  }

  const play = {
    roll() {
      for (let i = 0; i < 5; i++) noise(i * 0.07, 0.05);
    },
    step() {
      tone(520, 0, 0.06, "triangle", 0.06);
    },
    capture() {
      tone(440, 0, 0.12, "square", 0.06);
      tone(220, 0.1, 0.25, "square", 0.06);
    },
    home() {
      [523, 659, 784].forEach((f, i) => tone(f, i * 0.09, 0.2, "triangle", 0.09));
    },
    turn() {
      tone(880, 0, 0.12, "sine", 0.08);
      tone(1175, 0.1, 0.18, "sine", 0.08);
    },
    pop() {
      tone(660, 0, 0.08, "sine", 0.08);
      tone(990, 0.05, 0.1, "sine", 0.06);
    },
    six() {
      [784, 988, 1175].forEach((f, i) => tone(f, i * 0.06, 0.14, "square", 0.05));
    },
    coin() {
      tone(1318, 0, 0.08, "square", 0.04);
      tone(1760, 0.07, 0.18, "square", 0.04);
    },
    win() {
      [523, 659, 784, 1046, 784, 1046].forEach((f, i) => tone(f, i * 0.12, 0.3, "triangle", 0.1));
    },
  };

  return {
    unlock: context,
    get muted() {
      return muted;
    },
    toggle() {
      muted = !muted;
      try {
        localStorage.setItem("ludo-muted", muted ? "1" : "0");
      } catch {}
      return muted;
    },
    play: (name) => {
      try {
        play[name]();
      } catch {}
    },
    context: () => ctx,
  };
})();
