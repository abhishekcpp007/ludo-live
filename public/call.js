const Call = (() => {
  const VIDEO_MAX_BITRATE = 350000;
  const VIDEO_MAX_FPS = 24;
  const LEVEL_POLL_MS = 150;
  const SPEAK_THRESHOLD = 0.04;

  let socket = null;
  let localStream = null;
  let iceServers = [];
  let ready = false;
  const peers = new Map();
  const meters = new Map();
  const listeners = { stream: () => {}, leave: () => {}, state: () => {}, level: () => {} };

  async function init(sock, mode) {
    if (ready) return localStream;
    ready = true;
    socket = sock;
    try {
      iceServers = (await fetch("/config").then((r) => r.json())).iceServers;
    } catch {
      iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
    }
    if (mode !== "none" && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      const video = { width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: VIDEO_MAX_FPS }, facingMode: "user" };
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio, video: mode === "video" ? video : false });
      } catch {
        try {
          localStream = await navigator.mediaDevices.getUserMedia({ audio });
        } catch {
          localStream = null;
        }
      }
    }
    if (localStream) meter("local", localStream);
    socket.on("signal", (m) => onSignal(m).catch(() => {}));
    socket.on("peer-left", (sid) => drop(sid));
    setInterval(pollLevels, LEVEL_POLL_MS);
    return localStream;
  }

  function createPeer(sid, initiator) {
    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });
    const entry = { pc, pending: [], stream: new MediaStream(), initiator };
    peers.set(sid, entry);
    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit("signal", { to: sid, data: { candidate: e.candidate.toJSON() } });
    };
    pc.ontrack = (e) => {
      if (!entry.stream.getTracks().includes(e.track)) entry.stream.addTrack(e.track);
      if (e.track.kind === "audio") meter(sid, entry.stream);
      listeners.stream(sid, entry.stream);
    };
    pc.onconnectionstatechange = () => {
      listeners.state(sid, pc.connectionState);
      if (pc.connectionState === "failed" && entry.initiator && peers.get(sid) === entry) call(sid);
    };
    return entry;
  }

  async function capBitrate(pc) {
    for (const sender of pc.getSenders()) {
      if (!sender.track || sender.track.kind !== "video") continue;
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = VIDEO_MAX_BITRATE;
      params.encodings[0].maxFramerate = VIDEO_MAX_FPS;
      try {
        await sender.setParameters(params);
      } catch {}
    }
  }

  async function call(sid) {
    drop(sid, true);
    const { pc } = createPeer(sid, true);
    const kinds = new Set();
    if (localStream) {
      localStream.getTracks().forEach((t) => {
        pc.addTrack(t, localStream);
        kinds.add(t.kind);
      });
    }
    ["audio", "video"].filter((k) => !kinds.has(k)).forEach((k) => pc.addTransceiver(k, { direction: "recvonly" }));
    await pc.setLocalDescription(await pc.createOffer());
    socket.emit("signal", { to: sid, data: { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } } });
    capBitrate(pc);
  }

  async function onSignal({ from, data }) {
    let entry = peers.get(from);
    if (data.sdp && data.sdp.type === "offer") {
      drop(from, true);
      entry = createPeer(from, false);
      const { pc } = entry;
      await pc.setRemoteDescription(data.sdp);
      if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
      await pc.setLocalDescription(await pc.createAnswer());
      socket.emit("signal", { to: from, data: { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } } });
      capBitrate(pc);
      await flush(entry);
      return;
    }
    if (!entry) return;
    if (data.sdp && data.sdp.type === "answer") {
      if (entry.pc.signalingState !== "have-local-offer") return;
      await entry.pc.setRemoteDescription(data.sdp);
      await flush(entry);
    } else if (data.candidate) {
      if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(data.candidate).catch(() => {});
      else entry.pending.push(data.candidate);
    }
  }

  async function flush(entry) {
    for (const c of entry.pending.splice(0)) await entry.pc.addIceCandidate(c).catch(() => {});
  }

  function drop(sid, quiet) {
    const entry = peers.get(sid);
    if (!entry) return;
    entry.pc.close();
    peers.delete(sid);
    meters.delete(sid);
    if (!quiet) listeners.leave(sid);
  }

  function dropAll() {
    [...peers.keys()].forEach((sid) => drop(sid));
  }

  function meter(id, stream) {
    const ctx = Sound.context();
    if (!ctx || !stream.getAudioTracks().length || meters.has(id)) return;
    try {
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      meters.set(id, { analyser, buf: new Uint8Array(analyser.fftSize) });
    } catch {}
  }

  function pollLevels() {
    for (const [id, m] of meters) {
      m.analyser.getByteTimeDomainData(m.buf);
      let sum = 0;
      for (let i = 0; i < m.buf.length; i++) {
        const v = (m.buf[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / m.buf.length);
      const muted = id === "local" && localStream && !localStream.getAudioTracks().some((t) => t.enabled);
      listeners.level(id, !muted && rms > SPEAK_THRESHOLD);
    }
  }

  function setEnabled(kind, on) {
    if (!localStream) return;
    (kind === "audio" ? localStream.getAudioTracks() : localStream.getVideoTracks()).forEach((t) => (t.enabled = on));
  }

  function isEnabled(kind) {
    if (!localStream) return false;
    const tracks = kind === "audio" ? localStream.getAudioTracks() : localStream.getVideoTracks();
    return tracks.length > 0 && tracks[0].enabled;
  }

  function hasKind(kind) {
    if (!localStream) return false;
    return (kind === "audio" ? localStream.getAudioTracks() : localStream.getVideoTracks()).length > 0;
  }

  return {
    init,
    call,
    dropAll,
    setEnabled,
    isEnabled,
    hasKind,
    local: () => localStream,
    on: (evt, fn) => (listeners[evt] = fn),
  };
})();
