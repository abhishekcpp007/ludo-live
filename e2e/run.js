"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT = path.join(__dirname, "out");
const PLAY_MS = 45000;
const CALL_TIMEOUT_MS = 30000;
const MATCH_TIMEOUT_MS = 40000;
const DESKTOP = { width: 1366, height: 820 };
const MOBILE = { width: 390, height: 844 };

fs.mkdirSync(OUT, { recursive: true });
const results = [];
const problems = [];

function step(name, promise, ms = 60000) {
  console.log(`..  ${name}`);
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`step timed out: ${name}`)), ms))]);
}

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function newPlayer(browser, label, viewport = DESKTOP) {
  const ctx = await browser.newContext({ viewport, permissions: ["camera", "microphone"] });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`[${label}] console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`[${label}] pageerror: ${e.message}`));
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return { ctx, page, label };
}

async function fillLobby(page, name, mode = "video") {
  await page.goto(page.url() === "about:blank" ? BASE : page.url());
  await page.fill("#name", name);
  await page.check(`input[name=mode][value=${mode}]`, { force: true });
}

async function remoteVideoCount(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".tile video")].filter((v) => !v.muted && v.srcObject && v.videoWidth > 0).length
  );
}

async function remoteAudioCount(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll(".tile video")].filter((v) => !v.muted && v.srcObject && v.srcObject.getAudioTracks().some((t) => t.readyState === "live")).length
  );
}

async function waitFor(fn, timeout, step = 300) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

async function act(page) {
  return page.evaluate(() => {
    const d = document.getElementById("dice");
    if (d && !d.disabled) {
      d.click();
      return "roll";
    }
    const t = document.querySelector(".tok.can");
    if (t) {
      t.click();
      return "move";
    }
    return null;
  });
}

(async () => {
  const browser = await chromium.launch({
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  try {
    // Lobby look
    const host = await newPlayer(browser, "host");
    await fillLobby(host.page, "Abhishek");
    await host.page.screenshot({ path: path.join(OUT, "01-lobby-desktop.png") });
    const coins = await host.page.textContent("#coinsLobby");
    check("lobby shows starting coins", coins.replace(/,/g, "") === "1000", coins);

    // Friends room with 4 video players
    await host.page.check("input[name=stake][value='100']", { force: true });
    await host.page.click("#createBtn");
    await host.page.waitForSelector("#game:not(.hidden)");
    const code = (await host.page.textContent("#roomCode")).trim();
    check("room created", /^[A-Z0-9]{5}$/.test(code), code);

    const guests = [];
    for (const [i, name] of ["Rahul", "Priya", "Aman"].entries()) {
      const g = await newPlayer(browser, name, i === 2 ? MOBILE : DESKTOP);
      await g.page.goto(`${BASE}/?room=${code}`);
      await g.page.fill("#name", name);
      await g.page.check(`input[name=mode][value=${i === 1 ? "audio" : "video"}]`, { force: true });
      await g.page.click("#inviteJoinBtn");
      await g.page.waitForSelector("#game:not(.hidden)");
      guests.push(g);
    }
    const all = [host, ...guests];
    await host.page.screenshot({ path: path.join(OUT, "02-waiting-room.png") });

    const connected = await waitFor(async () => {
      const counts = await Promise.all(all.map((p) => remoteAudioCount(p.page)));
      return counts.every((n) => n === 3);
    }, CALL_TIMEOUT_MS);
    const audioCounts = await Promise.all(all.map((p) => remoteAudioCount(p.page)));
    check("every player hears the other 3 (audio tracks live)", connected, audioCounts.join(","));
    const videoCounts = await Promise.all(all.map((p) => remoteVideoCount(p.page)));
    check("video players are seen by everyone (Priya is audio-only)", videoCounts.every((n) => n >= 2), videoCounts.join(","));

    const startClicked = await host.page.isEnabled("#startBtn");
    check("host can start with 4 players", startClicked);
    await host.page.click("#startBtn");
    await host.page.waitForSelector("#waitPanel.hidden", { state: "attached" });
    const afterStake = (await host.page.textContent("#coinsBar")).replace(/,/g, "");
    check("entry fee charged", afterStake === "900", afterStake);
    const pot = await host.page.textContent("#potText");
    check("pot shows 4 x 100", /400/.test(pot), pot);

    // Emote + skin
    await host.page.click("#emoteBtn");
    await host.page.click("#emotePop button >> nth=1");
    const sawEmote = await waitFor(() => guests[0].page.evaluate(() => !!document.querySelector(".floater")), 3000, 100);
    check("emote reaches other players", sawEmote);

    await host.page.click("#shopBtn");
    await host.page.waitForSelector("#shop:not(.hidden)");
    await host.page.screenshot({ path: path.join(OUT, "03-shop.png") });
    const buyBtn = host.page.locator(".item", { hasText: "Glass" }).locator("button");
    await buyBtn.click();
    await buyBtn.click();
    const skinSeen = await waitFor(() => guests[0].page.evaluate(() => !!document.querySelector(".tok.red.skin-glass")), 4000, 100);
    check("bought skin is visible to others", skinSeen);
    await host.page.click("#shopClose");

    // Play by clicking for a while, measure smoothness on host
    const fpsProbe = host.page.evaluate(
      (ms) =>
        new Promise((resolve) => {
          const frames = [];
          let last = performance.now();
          const end = last + ms;
          (function f(t) {
            frames.push(t - last);
            last = t;
            if (t < end) requestAnimationFrame(f);
            else {
              const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
              const long = frames.filter((x) => x > 50).length;
              resolve({ fps: Math.round(1000 / avg), long, frames: frames.length });
            }
          })(last);
        }),
      8000
    );
    let rolls = 0;
    let moves = 0;
    let shot = false;
    const end = Date.now() + PLAY_MS;
    while (Date.now() < end) {
      for (const p of all) {
        const r = await step(`act ${p.label}`, act(p.page), 10000);
        if (r === "roll") rolls++;
        if (r === "move") moves++;
      }
      if (!shot && moves > 6) {
        await host.page.screenshot({ path: path.join(OUT, "04-game-desktop.png") });
        await guests[2].page.screenshot({ path: path.join(OUT, "05-game-mobile.png") });
        shot = true;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    const fps = await step("fps probe", fpsProbe, 20000);
    check("players rolled and moved through the UI", rolls > 20 && moves > 5, `${rolls} rolls, ${moves} manual moves`);
    check("frame rate with 4 live videos decoding (info)", true, `${fps.fps} fps, ${fps.long} frames over 50ms`);

    const latency = await step("latency", host.page.evaluate(
      () =>
        new Promise((resolve) => {
          const s = performance.now();
          const sock = io({ forceNew: true, transports: ["websocket"] });
          sock.on("connect", () => {
            const t = performance.now();
            sock.emit("hello", { pid: crypto.randomUUID() }, () => {
              resolve({ connect: Math.round(t - s), roundTrip: Math.round(performance.now() - t) });
              sock.disconnect();
            });
          });
        })
    ), 15000);
    check("server round trip under 50ms", latency.roundTrip < 50, `${latency.roundTrip}ms`);

    const states = await Promise.all(all.map((p) => p.page.evaluate(() => document.getElementById("log").textContent)));
    check("all players see the same game log", new Set(states).size === 1);

    await guests[2].page.screenshot({ path: path.join(OUT, "06-game-mobile-later.png") });
    await host.page.screenshot({ path: path.join(OUT, "07-game-desktop-later.png") });

    // Matchmaking with bots
    const solo = await newPlayer(browser, "solo", MOBILE);
    await solo.page.goto(BASE);
    await solo.page.fill("#name", "Stranger");
    await solo.page.check("input[name=mode][value=none]", { force: true });
    await solo.page.check("input[name=stake][value='100']", { force: true });
    await solo.page.click("#quickBtn");
    await solo.page.waitForSelector("#searching:not(.hidden)");
    await solo.page.screenshot({ path: path.join(OUT, "08-searching.png") });
    const matched = await waitFor(() => solo.page.evaluate(() => !document.getElementById("game").classList.contains("hidden") && /Bot|thinking|turn/i.test(document.getElementById("turnTitle").textContent + document.getElementById("turnSub").textContent)), MATCH_TIMEOUT_MS, 500);
    check("quick match fills with bots and starts", matched);
    const bots = await solo.page.evaluate(() => document.querySelectorAll(".tile .botTag:not(.hidden)").length);
    check("three bots seated", bots === 3, String(bots));
    const soloFps = await step("solo fps", solo.page.evaluate(
      (ms) =>
        new Promise((resolve) => {
          const frames = [];
          let last = performance.now();
          const end = last + ms;
          (function f(t) {
            frames.push(t - last);
            last = t;
            if (t < end) requestAnimationFrame(f);
            else resolve({ fps: Math.round(1000 / (frames.reduce((a, b) => a + b, 0) / frames.length)), long: frames.filter((x) => x > 50).length });
          })(last);
        }),
      6000
    ), 20000);
    check("board animation smooth while tokens move (no video)", soloFps.fps >= 50 && soloFps.long <= 3, `${soloFps.fps} fps, ${soloFps.long} frames over 50ms`);
    await solo.page.screenshot({ path: path.join(OUT, "09-vs-bots-mobile.png") });

    const csp = (await Promise.all([...all, solo].map((p) => p.page.evaluate(() => window.__csp)))).flat();
    check("no CSP violations", csp.length === 0, csp.slice(0, 3).join(" | "));
    const errs = problems.filter((p) => !/favicon/.test(p));
    check("no console errors", errs.length === 0, errs.slice(0, 3).join(" | "));
  } catch (err) {
    check("e2e run completed", false, err.stack);
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ results, problems }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})();
