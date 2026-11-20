(() => {
  const $ = (id) => document.getElementById(id);
  const COLORS = ["red", "green", "yellow", "blue"];
  const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  const TOAST_MS = 2400;
  const ROLL_ANIM_MS = 850;
  const FACE_ROT = { 1: [0, 0], 2: [0, -90], 3: [-90, 0], 4: [90, 0], 5: [0, 90], 6: [0, 180] };
  const FULL_TURN = 360;
  const CONFETTI_MS = 4000;
  const CONFETTI_COUNT = 140;
  const MEDAL = ["🥇", "🥈", "🥉", "4"];
  const fmt = (n) => Number(n || 0).toLocaleString("en-IN");
  const SIX_MS = 900;
  const EMOTE_MS = 2200;
  const EMOTE_TILE_MS = 1600;
  const BUY_CONFIRM_MS = 3000;
  const EMOTES = {
    laugh: "😂", clap: "👏", fire: "🔥", angry: "😡", cry: "😭", cool: "😎", wave: "👋", party: "🎉",
    gg: "Well played!", hurry: "Jaldi chalo!", oops: "Oops!", luck: "Good luck!", saved: "Bach gaya!", revenge: "Badla lunga!",
  };
  const isPhrase = (id) => EMOTES[id] && EMOTES[id].length > 3;

  const store = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, v);
      } catch {}
    },
  };

  function makePid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }
  let pid = store.get("ludo-pid");
  if (!pid || !/^[A-Za-z0-9-]{16,64}$/.test(pid)) {
    pid = makePid();
    store.set("ludo-pid", pid);
  }

  const socket = io({ reconnectionDelayMax: 4000 });
  let state = null;
  let myColor = null;
  let roomCode = null;
  let lastSeq = -1;
  let lastActionKey = null;
  let wasMyTurn = false;
  let coins = 0;
  let searchTimer = null;
  const spin = { x: 0, y: 0 };
  let wallet = { owned: ["classic"], skin: "classic", stats: null };
  let catalog = { skins: [], emotes: [] };
  const remoteStreams = new Map();
  const mutedPeers = new Set();
  const speaking = new Set();

  Board.draw($("boardSvg"), $("tokens"));
  buildDice();

  $("name").value = store.get("ludo-name") || "";
  const params = new URLSearchParams(location.search);
  const invited = (params.get("room") || "").toUpperCase();
  if (/^[A-Z0-9]{5}$/.test(invited)) {
    $("inviteJoin").classList.remove("hidden");
    $("normalJoin").classList.add("hidden");
    $("inviteJoinBtn").textContent = `Join room ${invited}`;
  }
  const savedStake = store.get("ludo-stake");
  if (savedStake) {
    const r = document.querySelector(`input[name=stake][value="${CSS.escape(savedStake)}"]`);
    if (r) r.checked = true;
  }

  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove("show"), TOAST_MS);
  }

  function lobbyError(msg) {
    $("lobbyErr").textContent = msg || "";
  }

  function setCoins(n, animate) {
    const changed = n !== coins;
    coins = n;
    $("coinsLobby").textContent = fmt(n);
    $("coinsBar").textContent = fmt(n);
    if (animate && changed) {
      document.querySelectorAll(".coins").forEach((el) => {
        el.classList.remove("bump");
        void el.offsetWidth;
        el.classList.add("bump");
      });
    }
  }

  function setWallet(w, animate) {
    if (!w || typeof w.coins !== "number") return;
    if (animate && w.coins > coins) Sound.play("coin");
    setCoins(w.coins, animate);
    $("coinsShop").textContent = fmt(w.coins);
    $("bonusBtn").classList.toggle("hidden", w.bonusIn > 0);
    if (w.owned) wallet.owned = w.owned;
    if (w.skin) wallet.skin = w.skin;
    if (w.stats) {
      wallet.stats = w.stats;
      const st = w.stats;
      $("statsLine").textContent = st.games ? `Games ${st.games} · Wins ${st.wins} · Coins won ${fmt(st.won)}` : "Pehla game khelo aur coins jeeto!";
    }
    if (!$("shop").classList.contains("hidden")) renderShop();
  }

  function renderShop() {
    const grid = $("shopGrid");
    grid.textContent = "";
    const color = myColor || "red";
    catalog.skins.forEach((item) => {
      const owned = wallet.owned.includes(item.id);
      const equipped = wallet.skin === item.id;
      const card = document.createElement("div");
      card.className = "item" + (equipped ? " equipped" : "");
      const prev = document.createElement("div");
      prev.className = "preview";
      const tok = document.createElement("div");
      tok.className = `tok ${color} skin-${item.id}`;
      tok.innerHTML = '<span class="pawn"></span>';
      prev.appendChild(tok);
      const nm = document.createElement("div");
      nm.className = "nm";
      nm.textContent = item.name;
      const btn = document.createElement("button");
      btn.className = "btn" + (owned ? "" : " primary");
      if (equipped) {
        btn.textContent = "Equipped";
        btn.disabled = true;
      } else if (owned) {
        btn.textContent = "Use";
        btn.onclick = () => socket.emit("equip", item.id, (res) => {
          if (res.error) return toast(res.error);
          Sound.play("pop");
          setWallet(res);
        });
      } else {
        btn.innerHTML = '<span class="coin"></span>';
        btn.append(fmt(item.price));
        btn.disabled = coins < item.price;
        btn.onclick = () => {
          if (!btn.classList.contains("confirm")) {
            btn.classList.add("confirm");
            btn.textContent = `Buy for ${fmt(item.price)}?`;
            setTimeout(() => renderShop(), BUY_CONFIRM_MS);
            return;
          }
          socket.emit("buy", item.id, (res) => {
            if (res.error) return toast(res.error);
            Sound.play("home");
            toast(`${item.name} unlocked!`);
            setWallet(res, true);
          });
        };
      }
      card.append(prev, nm, btn);
      grid.appendChild(card);
    });
  }

  function openShop() {
    Sound.unlock();
    renderShop();
    $("shop").classList.remove("hidden");
    $("shopClose").focus();
  }
  $("shopBtn").onclick = openShop;
  $("shopBtnLobby").onclick = openShop;
  $("shopClose").onclick = () => $("shop").classList.add("hidden");
  $("shop").addEventListener("click", (e) => e.target === $("shop") && $("shop").classList.add("hidden"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      $("shop").classList.add("hidden");
      closeEmotes();
    }
  });

  function buildEmotes() {
    const pop = $("emotePop");
    pop.textContent = "";
    Object.keys(EMOTES).forEach((id) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = EMOTES[id];
      if (isPhrase(id)) b.className = "phrase";
      b.onclick = () => {
        socket.emit("emote", id);
        closeEmotes();
      };
      pop.appendChild(b);
    });
  }
  function closeEmotes() {
    $("emotePop").classList.add("hidden");
    $("emoteBtn").setAttribute("aria-expanded", "false");
  }
  $("emoteBtn").onclick = (e) => {
    e.stopPropagation();
    const open = $("emotePop").classList.toggle("hidden");
    $("emoteBtn").setAttribute("aria-expanded", String(!open));
  };
  document.addEventListener("click", (e) => {
    if (!$("emotePop").contains(e.target)) closeEmotes();
  });
  buildEmotes();

  function showEmote({ color, id }) {
    if (!EMOTES[id] || mutedPeers.has(color)) return;
    Sound.play("pop");
    const tile = $(`tile-${color}`);
    const anchor = tile || $("board");
    const r = anchor.getBoundingClientRect();
    const f = document.createElement("div");
    f.className = "floater" + (isPhrase(id) ? " phrase" : "");
    f.textContent = EMOTES[id];
    f.style.left = `${r.left + r.width / 2}px`;
    f.style.top = `${r.top + r.height / 2}px`;
    f.style.setProperty("--fc", Board.HEX[color]);
    $("floaters").appendChild(f);
    setTimeout(() => f.remove(), EMOTE_MS);
    if (tile && !isPhrase(id)) {
      const e = document.createElement("div");
      e.className = "emo";
      e.textContent = EMOTES[id];
      tile.appendChild(e);
      setTimeout(() => e.remove(), EMOTE_TILE_MS);
    }
  }
  socket.on("emote", showEmote);

  function updateMusicBtn() {
    const on = Music.track !== "off";
    Icons.apply($("musicBtn"), on ? "music" : "musicOff");
    $("musicBtn").classList.toggle("off", !on);
    $("musicBtn").title = Music.label();
  }
  $("musicBtn").onclick = () => {
    toast(Music.cycle());
    updateMusicBtn();
  };
  updateMusicBtn();

  function sixBadge() {
    const b = document.createElement("div");
    b.className = "sixBadge";
    b.textContent = "SIX!";
    $("dice").closest(".turnCard").appendChild(b);
    setTimeout(() => b.remove(), SIX_MS);
    Sound.play("six");
  }

  function readForm() {
    const name = $("name").value.trim();
    if (!name) {
      lobbyError("Pehle apna naam daalo");
      $("name").focus();
      return null;
    }
    store.set("ludo-name", name);
    lobbyError("");
    const mode = document.querySelector("input[name=mode]:checked").value;
    const stake = Number(document.querySelector("input[name=stake]:checked").value);
    store.set("ludo-stake", String(stake));
    return { name, mode, stake };
  }

  function busy(on) {
    ["createBtn", "joinBtn", "quickBtn", "inviteJoinBtn"].forEach((id) => ($(id).disabled = on));
  }

  async function enterRoom(code, form, strangers) {
    busy(true);
    Sound.unlock();
    if (form.mode === "none" && Music.track === "off") Music.set("chill");
    Music.start();
    updateMusicBtn();
    await Call.init(socket, form.mode);
    socket.emit("join", { code, name: form.name, pid }, (res) => {
      busy(false);
      if (!res || res.error) {
        showSearching(false);
        return lobbyError(res ? res.error : "Could not join");
      }
      roomCode = code;
      myColor = res.color;
      setWallet(res);
      if (strangers) {
        Call.setEnabled("audio", false);
        Call.setEnabled("video", false);
        toast("Strangers ke saath mic aur camera off se shuru hote hain");
      }
      showSearching(false);
      $("lobby").classList.add("hidden");
      $("game").classList.remove("hidden");
      history.replaceState(null, "", strangers ? "/" : `?room=${code}`);
      updateMediaButtons();
      res.peers.forEach((sid) => Call.call(sid).catch(() => {}));
    });
  }

  $("createBtn").onclick = () => {
    const form = readForm();
    if (!form) return;
    busy(true);
    socket.emit("create", { stake: form.stake }, (res) => {
      busy(false);
      if (res.error) return lobbyError(res.error);
      enterRoom(res.code, form, false);
    });
  };

  $("joinBtn").onclick = () => {
    const form = readForm();
    if (!form) return;
    const code = $("code").value.trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code)) return lobbyError("5 letter ka room code daalo");
    enterRoom(code, form, false);
  };
  $("code").addEventListener("keydown", (e) => e.key === "Enter" && $("joinBtn").click());
  $("inviteJoinBtn").onclick = () => {
    const form = readForm();
    if (form) enterRoom(invited, form, false);
  };
  $("notInvite").onclick = () => {
    history.replaceState(null, "", "/");
    $("inviteJoin").classList.add("hidden");
    $("normalJoin").classList.remove("hidden");
  };

  function showSearching(on, stake) {
    $("searching").classList.toggle("hidden", !on);
    $("normalJoin").classList.toggle("hidden", on);
    clearInterval(searchTimer);
    if (!on) return;
    const started = Date.now();
    $("searchSub").textContent = `Table ${fmt(stake)} coins`;
    searchTimer = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      $("searchTitle").textContent = `Finding players… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }, 500);
  }

  let pendingQuick = null;
  $("quickBtn").onclick = () => {
    const form = readForm();
    if (!form) return;
    if (!form.stake) return lobbyError("Online tables need an entry: 100, 500 or 2500");
    if (coins < form.stake) return lobbyError(`Is table ke liye ${fmt(form.stake)} coins chahiye`);
    Sound.unlock();
    socket.emit("quick", { pid, name: form.name, stake: form.stake }, (res) => {
      if (res.error) return lobbyError(res.error);
      pendingQuick = form;
      showSearching(true, form.stake);
    });
  };
  $("cancelQuick").onclick = () => {
    socket.emit("quick-cancel", null, () => {});
    pendingQuick = null;
    showSearching(false);
  };
  socket.on("matched", ({ code }) => {
    if (!pendingQuick) return;
    const form = pendingQuick;
    pendingQuick = null;
    $("searchTitle").textContent = "Match found!";
    Sound.play("turn");
    enterRoom(code, form, true);
  });

  $("bonusBtn").onclick = () =>
    socket.emit("bonus", null, (res) => {
      if (res.error) toast(res.error);
      else toast("+500 coins added");
      setWallet(res, true);
    });

  async function invite() {
    if (!roomCode) return;
    const link = `${location.origin}/?room=${roomCode}`;
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      navigator.share({ title: "Ludo Live", text: "Aaja Ludo khelte hain", url: link }).catch(() => {});
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      toast("Invite link copied");
    } catch {
      toast(link);
    }
  }
  $("roomChip").onclick = invite;
  $("inviteBtn").onclick = invite;

  function updateMediaButtons() {
    const mic = $("micBtn");
    const cam = $("camBtn");
    const micOn = Call.isEnabled("audio");
    const camOn = Call.isEnabled("video");
    mic.disabled = !Call.hasKind("audio");
    cam.disabled = !Call.hasKind("video");
    Icons.apply(mic, micOn ? "mic" : "micOff");
    Icons.apply(cam, camOn ? "cam" : "camOff");
    mic.classList.toggle("off", Call.hasKind("audio") && !micOn);
    cam.classList.toggle("off", Call.hasKind("video") && !camOn);
    Icons.apply($("soundBtn"), Sound.muted ? "soundOff" : "sound");
    $("soundBtn").classList.toggle("off", Sound.muted);
    if (roomCode) socket.emit("media", { audio: micOn, video: camOn });
    renderVideos();
  }
  $("micBtn").onclick = () => {
    Call.setEnabled("audio", !Call.isEnabled("audio"));
    updateMediaButtons();
  };
  $("camBtn").onclick = () => {
    Call.setEnabled("video", !Call.isEnabled("video"));
    updateMediaButtons();
  };
  $("soundBtn").onclick = () => {
    Sound.toggle();
    updateMediaButtons();
  };
  $("leaveBtn").onclick = () => {
    if (state && state.phase === "playing" && !confirmLeave()) return;
    socket.emit("leave", null, () => (location.href = "/"));
    setTimeout(() => (location.href = "/"), 800);
  };
  function confirmLeave() {
    const btn = $("leaveBtn");
    if (btn.dataset.armed) return true;
    btn.dataset.armed = "1";
    toast("Game chal raha hai. Leave karne ke liye dobara dabao");
    setTimeout(() => delete btn.dataset.armed, TOAST_MS);
    return false;
  }

  $("startBtn").onclick = () => socket.emit("start", null, (res) => res && res.error && toast(res.error));
  $("restartBtn").onclick = () => {
    if (state && state.isPublic) location.href = "/";
    else socket.emit("restart");
  };
  $("dice").onclick = () => {
    Sound.unlock();
    socket.emit("roll");
  };

  document.addEventListener("keydown", (e) => {
    if (!state || e.target.tagName === "INPUT") return;
    if ((e.key === " " || e.key === "Enter") && !$("dice").disabled) {
      e.preventDefault();
      $("dice").click();
    }
    const n = Number(e.key);
    if (n >= 1 && n <= 4 && state.turn === myColor && state.movable.includes(n - 1)) socket.emit("move", n - 1);
  });

  function buildDice() {
    const cube = $("cube");
    for (let n = 1; n <= 6; n++) {
      const face = document.createElement("span");
      face.className = `dface s${n}`;
      const on = new Set(PIPS[n]);
      for (let i = 0; i < 9; i++) {
        const p = document.createElement("span");
        p.className = on.has(i) ? "pip on" : "pip";
        face.appendChild(p);
      }
      cube.appendChild(face);
    }
    showFace(6);
  }
  function cubeTo(n, extraX, extraY) {
    const [fx, fy] = FACE_ROT[n] || FACE_ROT[1];
    spin.x = Math.ceil(spin.x / FULL_TURN) * FULL_TURN + extraX * FULL_TURN;
    spin.y = Math.ceil(spin.y / FULL_TURN) * FULL_TURN + extraY * FULL_TURN;
    $("cube").style.transform = `rotateX(${spin.x + fx}deg) rotateY(${spin.y + fy}deg)`;
  }
  function showFace(n) {
    const cube = $("cube");
    if (cube.dataset.face === String(n)) return;
    cube.dataset.face = String(n);
    cube.classList.remove("spinning");
    cubeTo(n, 0, 0);
  }
  function animateRoll(final) {
    const dice = $("dice");
    const cube = $("cube");
    dice.classList.remove("rolling");
    void dice.offsetWidth;
    dice.classList.add("rolling");
    cube.classList.add("spinning");
    cube.dataset.face = String(final);
    Sound.play("roll");
    cubeTo(final, 2 + Math.floor(Math.random() * 2), 1 + Math.floor(Math.random() * 2));
    setTimeout(() => {
      dice.classList.remove("rolling");
      cube.classList.remove("spinning");
      Sound.play("step");
      if (final === 6) sixBadge();
    }, ROLL_ANIM_MS);
  }

  Call.on("stream", (sid, stream) => {
    remoteStreams.set(sid, stream);
    renderVideos();
  });
  Call.on("leave", (sid) => {
    remoteStreams.delete(sid);
    renderVideos();
  });
  Call.on("state", (sid, st) => {
    const p = state && state.players.find((x) => x.sid === sid);
    if (!p) return;
    const tile = $(`tile-${p.color}`);
    if (tile) tile.dataset.conn = st;
    renderVideos();
  });
  Call.on("level", (id, on) => {
    const color = id === "local" ? myColor : state && (state.players.find((p) => p.sid === id) || {}).color;
    if (!color) return;
    const tile = $(`tile-${color}`);
    if (!tile) return;
    const muted = id !== "local" && mutedPeers.has(color);
    tile.classList.toggle("speaking", on && !muted);
    if (on) speaking.add(color);
    else speaking.delete(color);
  });

  function tileFor(color) {
    let tile = $(`tile-${color}`);
    if (tile) return tile;
    tile = document.createElement("div");
    tile.id = `tile-${color}`;
    tile.innerHTML =
      '<div class="avatar"><span></span></div><video autoplay playsinline></video>' +
      '<button class="mute" type="button" aria-label="Mute this player"></button>' +
      '<span class="botTag hidden">BOT</span>' +
      '<div class="label"><span class="host hidden"></span><span class="nm"></span><span class="badge hidden"></span></div>';
    Icons.apply(tile.querySelector(".host"), "crown");
    Icons.apply(tile.querySelector(".badge"), "micOff");
    Icons.apply(tile.querySelector(".mute"), "sound");
    tile.querySelector(".mute").onclick = () => {
      if (mutedPeers.has(color)) mutedPeers.delete(color);
      else mutedPeers.add(color);
      renderVideos();
    };
    $("videos").appendChild(tile);
    return tile;
  }

  function renderVideos() {
    if (!state) return;
    const byColor = Object.fromEntries(state.players.map((p) => [p.color, p]));
    const slots = state.phase === "lobby" ? COLORS : COLORS.filter((c) => byColor[c]);
    COLORS.forEach((c) => {
      if (!slots.includes(c) && $(`tile-${c}`)) $(`tile-${c}`).remove();
    });
    slots.forEach((color) => {
      const p = byColor[color];
      const tile = tileFor(color);
      const video = tile.querySelector("video");
      const mute = tile.querySelector(".mute");
      if (!p) {
        tile.className = `tile empty ${color}`;
        tile.querySelector(".nm").textContent = "Waiting…";
        tile.querySelector(".avatar span").textContent = "";
        video.srcObject = null;
        mute.classList.add("hidden");
        return;
      }
      const isMe = color === myColor;
      const stream = isMe ? Call.local() : p.sid ? remoteStreams.get(p.sid) : null;
      const camOn = isMe ? Call.isEnabled("video") : p.media.video;
      const micOn = isMe ? Call.isEnabled("audio") : p.media.audio;
      tile.className = `tile ${color}` + (state.phase === "playing" && state.turn === color ? " turn" : "") + (p.online ? "" : " offline") + (speaking.has(color) ? " speaking" : "");
      tile.querySelector(".nm").textContent = isMe ? `${p.name} (you)` : p.online ? p.name : `${p.name} · offline`;
      tile.querySelector(".avatar span").textContent = [...p.name.replace("🤖 ", "")][0].toUpperCase();
      tile.querySelector(".host").classList.toggle("hidden", !p.host || state.isPublic);
      tile.querySelector(".badge").classList.toggle("hidden", p.bot || micOn);
      tile.querySelector(".botTag").classList.toggle("hidden", !p.bot);
      mute.classList.toggle("hidden", isMe || p.bot || !stream);
      mute.classList.toggle("on", mutedPeers.has(color));
      Icons.apply(mute, mutedPeers.has(color) ? "soundOff" : "sound");
      if (video.srcObject !== (stream || null)) video.srcObject = stream || null;
      video.muted = isMe || mutedPeers.has(color);
      video.classList.toggle("mirror", isMe);
      const show = !!stream && camOn && stream.getVideoTracks().length > 0;
      video.classList.toggle("show", show);
      if (stream && video.paused) video.play().catch(() => {});
    });
  }

  function renderWait(s, isHost) {
    const show = s.phase === "lobby";
    $("waitPanel").classList.toggle("hidden", !show);
    if (!show) return;
    $("waitCount").textContent = s.isPublic
      ? "Match found, starting…"
      : `${s.players.length}/4 players` + (s.stake ? ` · entry ${fmt(s.stake)} coins` : " · free table");
    const list = $("waitList");
    list.textContent = "";
    COLORS.forEach((c) => {
      const p = s.players.find((x) => x.color === c);
      const li = document.createElement("li");
      const sw = document.createElement("span");
      sw.className = `sw ${c}`;
      li.appendChild(sw);
      li.append(p ? `${p.name}${p.host && !s.isPublic ? " (host)" : ""}${p.color === myColor ? " · you" : ""}` : "Open seat");
      if (!p) li.className = "empty";
      list.appendChild(li);
    });
    $("inviteBtn").classList.toggle("hidden", s.isPublic);
    $("startBtn").classList.toggle("hidden", !isHost || s.isPublic);
    $("startBtn").disabled = s.players.length < 2;
    $("waitHint").textContent = s.isPublic ? "" : isHost ? (s.players.length < 2 ? "Dosto ko invite link bhejo" : "Sab aa gaye? Start dabao") : "Host game start karega";
  }

  let confettiShown = false;
  function renderOver(s, isHost) {
    const show = s.phase === "over";
    $("overPanel").classList.toggle("hidden", !show);
    if (!show) {
      confettiShown = false;
      return;
    }
    const pod = $("podium");
    pod.textContent = "";
    s.winners.forEach((c, i) => {
      const p = s.players.find((x) => x.color === c);
      const li = document.createElement("li");
      const rank = document.createElement("span");
      rank.className = "rank";
      rank.textContent = MEDAL[i];
      const sw = document.createElement("span");
      sw.className = `sw ${c}`;
      li.append(rank, sw, p ? p.name : c);
      if (i === 0 && s.pot) {
        const win = document.createElement("span");
        win.className = "win";
        win.style.marginLeft = "auto";
        win.textContent = `+${fmt(s.pot)}`;
        li.appendChild(win);
      }
      pod.appendChild(li);
    });
    const iWon = s.winners[0] === myColor;
    $("overTitle").textContent = iWon ? "You won!" : `${(s.players.find((x) => x.color === s.winners[0]) || {}).name || "Someone"} wins!`;
    $("restartBtn").textContent = s.isPublic ? "Find new match" : "Play again";
    $("restartBtn").classList.toggle("hidden", !s.isPublic && !isHost);
    $("overHint").textContent = iWon ? (s.pot ? `Tumne ${fmt(s.pot)} coins jeete!` : "Tum jeet gaye!") : s.isPublic || isHost ? "" : "Host naya game shuru karega";
    if (!confettiShown) {
      confettiShown = true;
      if (iWon) {
        Sound.play("win");
        confetti();
      }
    }
  }

  function renderTurn(s) {
    const myTurn = s.phase === "playing" && s.turn === myColor;
    const dice = $("dice");
    dice.disabled = !(myTurn && !s.rolled);
    dice.classList.toggle("ready", myTurn && !s.rolled);
    COLORS.forEach((c) => dice.classList.toggle(`c-${c}`, s.turn === c));
    dice.closest(".turnCard").classList.toggle("mine", myTurn);

    const tp = s.players.find((p) => p.color === s.turn);
    let title = "";
    let sub = "";
    if (s.phase === "lobby") {
      title = "Waiting to start";
    } else if (s.phase === "over") {
      title = "Game over";
    } else if (myTurn) {
      title = "Your turn";
      sub = s.rolled ? (s.movable.length > 1 ? "Ek goti chuno" : "") : "Dice roll karo (Space)";
    } else {
      title = tp ? `${tp.name}'s turn` : "";
      sub = tp && tp.bot ? "Bot is thinking…" : s.rolled ? "Chaal soch rahe hain…" : "Rolling…";
    }
    $("turnTitle").textContent = title;
    $("turnSub").textContent = sub;
    $("potLine").classList.toggle("hidden", !s.pot);
    $("potText").textContent = `Pot ${fmt(s.pot)}`;

    const fill = $("timerFill");
    fill.classList.remove("run");
    fill.style.animationDuration = "";
    if (s.turnDeadline && s.phase === "playing") {
      const remaining = s.turnDeadline - s.now;
      if (remaining > 0) {
        void fill.offsetWidth;
        fill.style.animationDuration = `${remaining}ms`;
        fill.classList.add("run");
      }
    }
    if (myTurn && !wasMyTurn) {
      Sound.play("turn");
      if (navigator.vibrate) navigator.vibrate(60);
    }
    wasMyTurn = myTurn;
  }

  function renderLog(s) {
    const log = $("log");
    log.textContent = "";
    s.log.slice(-5).forEach((line) => {
      const li = document.createElement("li");
      li.textContent = line;
      log.appendChild(li);
    });
  }

  socket.on("state", (s) => {
    if (s.seq <= lastSeq && s.code === (state && state.code)) return;
    lastSeq = s.seq;
    const prev = state;
    state = s;
    const me = s.players.find((p) => p.color === myColor);
    const isHost = !!(me && me.host);
    $("roomCode").textContent = s.code;

    const a = s.action;
    const actionKey = a ? JSON.stringify(a) : null;
    const fresh = actionKey && actionKey !== lastActionKey;
    lastActionKey = actionKey;
    if (fresh && a.type === "roll") animateRoll(a.dice);
    else if (s.dice) showFace(s.dice);
    if (prev && prev.phase !== "lobby" && s.phase === "lobby") {
      Board.reset();
      showFace(6);
    }

    Board.render(s, myColor, (idx) => socket.emit("move", idx), {
      step: () => Sound.play("step"),
      capture: () => {
        Sound.play("capture");
        if (a.captured.some((c) => c.color === myColor)) toast("Arre! Tumhari goti kat gayi");
        else if (a.color === myColor) toast("Goti kaat di!");
      },
      home: () => Sound.play("home"),
    });

    renderTurn(s);
    renderWait(s, isHost);
    renderOver(s, isHost);
    renderLog(s);
    renderVideos();
  });

  socket.on("wallet", (w) => setWallet(w, true));

  socket.on("kicked", (msg) => {
    toast(msg);
    roomCode = null;
    setTimeout(() => (location.href = "/"), 1500);
  });

  socket.on("connect", () => {
    $("netDot").classList.remove("off");
    $("netBanner").classList.add("hidden");
    socket.emit("hello", { pid }, (w) => {
      if (w && w.catalog) catalog = w.catalog;
      setWallet(w);
    });
    if (roomCode) {
      socket.emit("join", { code: roomCode, name: $("name").value.trim(), pid }, (res) => {
        if (res && res.ok) res.peers.forEach((sid) => Call.call(sid).catch(() => {}));
        else if (res && res.error) {
          toast(res.error);
          setTimeout(() => (location.href = "/"), 1500);
        }
      });
    }
  });
  socket.on("disconnect", () => {
    $("netDot").classList.add("off");
    if (roomCode) $("netBanner").classList.remove("hidden");
  });

  function confetti() {
    const canvas = $("confetti");
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = (canvas.width = canvas.clientWidth * dpr);
    const h = (canvas.height = canvas.clientHeight * dpr);
    const colors = Object.values(Board.HEX).concat("#ffffff", "#a78bfa");
    const parts = Array.from({ length: CONFETTI_COUNT }, () => ({
      x: Math.random() * w,
      y: -Math.random() * h * 0.5,
      vx: (Math.random() - 0.5) * 3 * dpr,
      vy: (2 + Math.random() * 4) * dpr,
      r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      s: (5 + Math.random() * 6) * dpr,
      c: colors[Math.floor(Math.random() * colors.length)],
    }));
    const end = performance.now() + CONFETTI_MS;
    (function frame(t) {
      ctx.clearRect(0, 0, w, h);
      parts.forEach((p) => {
        p.x += p.vx;
        p.y += p.vy;
        p.r += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
        ctx.restore();
      });
      if (t < end) requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, w, h);
    })(performance.now());
  }

  updateMediaButtons();
})();
