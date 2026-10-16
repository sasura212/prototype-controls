#!/usr/bin/env node
// The screenshot tour, run by the player's server (or by hand): a headless Chrome of its own walks the
// flow through the player and takes a real screenshot of every step and every error, at 2× pixel
// density so text is sharp. Local only, like the rest of `.prototype/`. Needs Node 22+ (built-in
// WebSocket) and a Chrome or Edge on the machine (or CHROME_PATH).
//
//   node .prototype/tour.mjs                         the dev server at http://localhost:5173, 1440 × 900
//   node .prototype/tour.mjs http://localhost:5187 --width 390 --height 844 --scale 3
//
// Writes .prototype/shots/<run>/ and .prototype/shots/latest/, each with a manifest.json the flow
// review (/__prototype/sheet) reads.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** A Chrome to drive: CHROME_PATH, the usual install places, or Playwright's download. */
const findChrome = () => {
  const home = os.homedir();
  const versioned = (dir, tail) => {
    try {
      return fs
        .readdirSync(dir)
        .filter((name) => name.startsWith("chromium"))
        .sort()
        .reverse()
        .map((name) => path.join(dir, name, tail));
    } catch {
      return [];
    }
  };
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    path.join(home, "AppData/Local/Google/Chrome/Application/chrome.exe"),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    ...versioned(path.join(home, "AppData/Local/ms-playwright"), "chrome-win64/chrome.exe"),
    ...versioned(path.join(home, "Library/Caches/ms-playwright"), "chrome-mac/Chromium.app/Contents/MacOS/Chromium"),
    ...versioned(path.join(home, ".cache/ms-playwright"), "chrome-linux/chrome"),
  ].filter(Boolean);
  const found = candidates.find((file) => fs.existsSync(file));
  if (!found) throw new Error("No Chrome found. Set CHROME_PATH to a Chrome or Edge executable.");
  return found;
};

/** A minimal Chrome DevTools Protocol client over the browser's WebSocket. */
const connect = async (wsUrl) => {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const waiting = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const pending = message.id && waiting.get(message.id);
    if (!pending) return;
    waiting.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  return { send, close: () => socket.close() };
};

/**
 * Walks the flow and screenshots it. `onProgress` hears each step: { done, total, label }.
 * Returns the manifest it wrote.
 */
export const runTour = async ({ origin, width = 1440, height = 900, scale = 2, onProgress = () => {} }) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "prototype-tour-"));
  const chrome = spawn(
    findChrome(),
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      `--window-size=${width},${height}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("Chrome didn't start")), 20_000);
      chrome.stderr.on("data", (chunk) => {
        output += chunk;
        const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      chrome.on("exit", () => reject(new Error("Chrome exited before it was ready")));
    });
    const cdp = await connect(wsUrl);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const page = (method, params) => cdp.send(method, params, sessionId);
    await page("Page.enable");
    await page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: width < 600 });

    /** Runs an expression in the page; null while the page is between loads. */
    const evaluate = async (expression) => {
      try {
        const { result } = await page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        return result?.value ?? null;
      } catch {
        return null;
      }
    };
    const player = async () => {
      for (let i = 0; i < 300; i++) {
        if (await evaluate("Boolean(window.__prototype) && document.readyState === 'complete'")) return;
        await sleep(100);
      }
      throw new Error("The player didn't load. Is the dev server running with .prototype/vite.config.mjs?");
    };
    /** Until the player stops: paused where it was headed, done, or stuck a while. */
    const settled = async () => {
      let stuckSince = null;
      for (let waited = 0; waited < 120_000; waited += 300) {
        await sleep(300);
        const result = await evaluate("window.__prototype && JSON.stringify(window.__prototype.result())");
        if (!result) continue;
        const state = JSON.parse(result);
        stuckSince = state.waitingFor ? (stuckSince ?? waited) : null;
        if (!state.skipping && (state.paused || state.done || (stuckSince !== null && waited - stuckSince > 30_000)))
          return state;
      }
      return null;
    };

    await page("Page.navigate", { url: origin });
    await player();
    const info = JSON.parse(
      await evaluate("JSON.stringify({ chapters: __prototype.chapters, paths: __prototype.paths })")
    );
    const total = info.chapters.length + info.paths.length;
    const run = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const runDir = path.join(here, "shots", run);
    const latestDir = path.join(here, "shots", "latest");
    const previous = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(latestDir, "manifest.json"), "utf8"));
      } catch {
        return null;
      }
    })();
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(latestDir, { recursive: true });

    const shots = [];
    const shoot = async (name, kind, title) => {
      const issues = JSON.parse((await evaluate("JSON.stringify(__prototype.audit())")) ?? "[]");
      await evaluate("__prototype.setHidden(true)");
      await sleep(150);
      const { data } = await page("Page.captureScreenshot", { format: "png" });
      await evaluate("__prototype.setHidden(false)");
      const png = Buffer.from(data, "base64");
      fs.writeFileSync(path.join(runDir, `${name}.png`), png);
      fs.writeFileSync(path.join(latestDir, `${name}.png`), png);
      const before = previous?.shots.find((shot) => shot.name === name)?.file ?? null;
      shots.push({ name, kind, title, file: `shots/${run}/${name}.png`, before, issues });
    };

    onProgress({ done: 0, total, label: "Starting from the top" });
    await evaluate("__prototype.restart()");
    await sleep(1500);
    await player();
    await sleep(2500);
    for (const [index, title] of info.chapters.entries()) {
      onProgress({ done: index, total, label: `Step ${index + 1} of ${info.chapters.length}: ${title}` });
      if (index > 0) {
        await evaluate(`__prototype.goTo(${index})`);
        await settled();
        await sleep(300);
      }
      await shoot(`${String(index + 1).padStart(2, "0")}-${slug(title)}`, "step", title);
    }
    for (const [index, item] of info.paths.entries()) {
      onProgress({
        done: info.chapters.length + index,
        total,
        label: `Error ${index + 1} of ${info.paths.length}: ${item.label}`,
      });
      await evaluate(`__prototype.showPath(${JSON.stringify(item.id)})`);
      await sleep(1500);
      await player();
      await settled();
      await shoot(`error-${item.id}`, "error", item.label);
    }

    const manifest = { run, at: new Date().toISOString(), viewport: `${width} × ${height} at ${scale}×`, shots };
    const json = JSON.stringify(manifest, null, 2);
    fs.writeFileSync(path.join(runDir, "manifest.json"), json);
    fs.writeFileSync(path.join(latestDir, "manifest.json"), json);
    onProgress({ done: total, total, label: `${shots.length} screens saved` });
    cdp.close();
    return manifest;
  } finally {
    chrome.kill();
    // Chrome lets go of its profile a moment after it exits.
    setTimeout(() => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 }), 1500);
  }
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const at = args.indexOf(`--${name}`);
    return at >= 0 ? Number(args[at + 1]) : fallback;
  };
  const origin = args.find((arg) => arg.startsWith("http")) ?? "http://localhost:5173";
  runTour({
    origin,
    width: option("width", 1440),
    height: option("height", 900),
    scale: option("scale", 2),
    onProgress: ({ done, total, label }) => console.log(`[${done}/${total}] ${label}`),
  }).then(
    (manifest) => console.log(`Done: .prototype/shots/${manifest.run}/ (open /__prototype/sheet to review)`),
    (error) => {
      console.error(error.message);
      process.exit(1);
    }
  );
}
