const Music = (() => {
  const LOOKAHEAD_S = 0.25;
  const TICK_MS = 80;
  const VOLUME = 0.07;
  const TRACKS = ["off", "chill", "desi", "arcade"];
  const LABELS = { off: "Music off", chill: "Chill lo-fi", desi: "Desi beat", arcade: "Arcade" };

  const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
  const SONGS = {
    chill: {
      bpm: 78,
      steps: 16,
      chords: [[57, 60, 64, 67], [50, 57, 60, 65], [55, 59, 62, 65], [48, 55, 59, 64]],
      melody: [76, null, 74, null, 72, null, null, 69, 72, null, 74, null, 76, null, 79, null],
      drums: { k: [0, 8, 10], s: [4, 12], h: [0, 2, 4, 6, 8, 10, 12, 14] },
      pad: "triangle",
      lead: "sine",
    },
    desi: {
      bpm: 104,
      steps: 16,
      chords: [[50, 57, 62], [50, 57, 62], [48, 55, 60], [50, 57, 62]],
      melody: [74, 76, 78, null, 81, null, 78, 76, 74, null, 71, null, 74, 76, null, null],
      drums: { k: [0, 3, 6, 10], s: [4, 12, 14], h: [2, 8, 11] },
      pad: "sawtooth",
      lead: "triangle",
      tabla: true,
    },
    arcade: {
      bpm: 132,
      steps: 16,
      chords: [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]],
      melody: [72, 76, 79, 76, 72, 76, 79, 84, 81, 79, 76, 79, 77, 76, 74, 71],
      drums: { k: [0, 4, 8, 12], s: [4, 12], h: [2, 6, 10, 14] },
      pad: "square",
      lead: "square",
    },
  };

  let ctx = null;
  let master = null;
  let current = "off";
  let timer = null;
  let nextTime = 0;
  let step = 0;
  let bar = 0;

  try {
    const saved = localStorage.getItem("ludo-music");
    if (TRACKS.includes(saved)) current = saved;
  } catch {}

  function env(node, t, a, peak, d) {
    node.gain.setValueAtTime(0, t);
    node.gain.linearRampToValueAtTime(peak, t + a);
    node.gain.exponentialRampToValueAtTime(0.0001, t + d);
  }

  function note(freq, t, dur, type, peak) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    env(g, t, 0.01, peak, dur);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  function kick(t) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.15);
    env(g, t, 0.003, 0.9, 0.22);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.25);
  }

  let noiseBuf = null;
  function hit(t, freq, dur, peak) {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.3, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = ctx.createBufferSource();
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    src.buffer = noiseBuf;
    f.type = "bandpass";
    f.frequency.value = freq;
    env(g, t, 0.002, peak, dur);
    src.connect(f).connect(g).connect(master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  function tabla(t, high) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(high ? 420 : 180, t);
    o.frequency.exponentialRampToValueAtTime(high ? 380 : 110, t + 0.18);
    env(g, t, 0.003, 0.5, 0.2);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.25);
  }

  function schedule() {
    const song = SONGS[current];
    if (!song) return;
    const stepDur = 60 / song.bpm / 4;
    while (nextTime < ctx.currentTime + LOOKAHEAD_S) {
      const t = nextTime;
      const chord = song.chords[bar % song.chords.length];
      if (step === 0 || step === 8) chord.forEach((n) => note(midi(n), t, stepDur * 8, song.pad, 0.05));
      if (step % 4 === 0) note(midi(chord[0] - 12), t, stepDur * 3, "sine", 0.18);
      const m = song.melody[step];
      if (m && (bar % 2 === 1 || current !== "chill")) note(midi(m), t, stepDur * 1.8, song.lead, 0.07);
      if (song.drums.k.includes(step)) song.tabla ? tabla(t, false) : kick(t);
      if (song.drums.s.includes(step)) song.tabla ? tabla(t, true) : hit(t, 1800, 0.12, 0.35);
      if (song.drums.h.includes(step)) hit(t, 8000, 0.04, 0.12);
      nextTime += stepDur;
      step = (step + 1) % song.steps;
      if (step === 0) bar++;
    }
  }

  function start() {
    ctx = Sound.unlock();
    if (!ctx || current === "off") return;
    if (!master) {
      master = ctx.createGain();
      master.connect(ctx.destination);
    }
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(VOLUME, ctx.currentTime);
    nextTime = ctx.currentTime + 0.05;
    step = 0;
    bar = 0;
    clearInterval(timer);
    timer = setInterval(schedule, TICK_MS);
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    if (master && ctx) master.gain.setTargetAtTime(0, ctx.currentTime, 0.1);
  }

  function set(track) {
    current = track;
    try {
      localStorage.setItem("ludo-music", track);
    } catch {}
    stop();
    if (track !== "off") start();
    return LABELS[track];
  }

  function cycle() {
    return set(TRACKS[(TRACKS.indexOf(current) + 1) % TRACKS.length]);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else if (current !== "off" && ctx) start();
  });

  return {
    start,
    stop,
    set,
    cycle,
    get track() {
      return current;
    },
    label: () => LABELS[current],
  };
})();
