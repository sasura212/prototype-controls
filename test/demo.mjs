// Makes docs/demo.gif from the test fixture: Play, the wrong-code error from the ⚗ panel, then a
// comment sent to Claude, answered and resolved with comment.mjs. Real mouse and keyboard input in a
// headless Chrome at 1280 × 800, a screenshot every ~150 ms. Not part of `npm test`.
//
//   node test/demo.mjs
//
// The frames go to docs/demo-frames/ with frames.txt (each frame's real duration). With ffmpeg on
// the PATH it then makes docs/demo.gif and deletes the frames; without, it prints the command to run.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect, extraChromeArgs, findChrome } from "../templates/tour.mjs";
import { dot, repo, sleep, startFixture } from "./fixture.mjs";

const WIDTH = 1280;
const HEIGHT = 800;
const EVERY_MS = 150;
const frames = path.join(repo, "docs/demo-frames");
const gif = path.join(repo, "docs/demo.gif");
// Run from the repo root, so the same command can be printed for running by hand.
const ffmpegArgs = [
  ["-y", "-f", "concat", "-safe", "0", "-i", "docs/demo-frames/frames.txt"],
  [
    "-vf",
    "fps=13,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4",
  ],
  ["-loop", "0", "docs/demo.gif"],
].flat();

// The fixture has no styles of its own (the tests don't need any); for the demo it gets a few, so it
// reads as an app. Only here: the fixture the tests run is untouched.
const CSS = `
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; color: #111827; background: #f8fafc; }
  #app { max-width: 440px; margin: 72px auto; padding: 32px; background: #fff; border-radius: 16px;
    box-shadow: 0 1px 3px rgba(0,0,0,.08), 0 12px 32px rgba(0,0,0,.06); }
  h1 { margin: 0 0 12px; font-size: 26px; }
  label { display: grid; gap: 6px; margin: 16px 0; font-weight: 500; }
  input { font: inherit; padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 8px; }
  input[maxlength="1"] { width: 22px; margin-right: 6px; text-align: center; }
  button, [role=button] { font: inherit; padding: 8px 14px; margin: 4px 6px 4px 0; border: 1px solid #cbd5e1;
    border-radius: 8px; background: #fff; cursor: pointer; display: inline-block; }
  #continue { background: #111827; color: #fff; border-color: #111827; }
  [role=menu] { margin-top: 6px; padding: 4px; border: 1px solid #e2e8f0; border-radius: 8px; width: 140px; }
  [role=menuitem] { padding: 6px 10px; border-radius: 6px; background: #f1f5f9; }
  #error { color: #b91c1c; }`;
const STYLE = `addEventListener("DOMContentLoaded", () => {
  const style = document.createElement("style");
  style.textContent = ${JSON.stringify(CSS)};
  document.head.append(style);
});`;

// Headless screenshots have no mouse pointer: a dot that follows the real mouse events stands in for it.
const CURSOR = `addEventListener("DOMContentLoaded", () => {
  const dot = document.createElement("div");
  dot.style.cssText = "position:fixed;left:-40px;top:-40px;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;" +
    "background:rgba(37,99,235,.35);border:2px solid #2563eb;pointer-events:none;z-index:2147483647;transition:transform .1s";
  document.documentElement.append(dot);
  addEventListener("mousemove", (e) => { dot.style.left = e.clientX + "px"; dot.style.top = e.clientY + "px"; }, true);
  addEventListener("mousedown", () => (dot.style.transform = "scale(.7)"), true);
  addEventListener("mouseup", () => (dot.style.transform = ""), true);
});`;

const { origin, stop } = await startFixture(5197);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "prototype-demo-"));
const chrome = spawn(
  findChrome(),
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--hide-scrollbars",
    `--window-size=${WIDTH},${HEIGHT}`,
    ...extraChromeArgs(),
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);
try {
  const wsUrl = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Chrome didn't start")), 20_000);
    chrome.stderr.on("data", (chunk) => {
      const match = (output += chunk).match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
  const cdp = await connect(wsUrl);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = (method, params, timeoutMs) => cdp.send(method, params, sessionId, timeoutMs);
  await page("Emulation.setDeviceMetricsOverride", {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page("Page.enable");
  for (const source of [STYLE, CURSOR]) await page("Page.addScriptToEvaluateOnNewDocument", { source });
  const evaluate = async (expression) => {
    try {
      const { result } = await page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      return result?.value ?? null;
    } catch {
      return null; // Between page loads.
    }
  };
  const until = async (test, ms = 15_000) => {
    for (const started = Date.now(); Date.now() - started < ms; await sleep(100)) if (await evaluate(test)) return;
    throw new Error(`Never true: ${test}`);
  };
  const player = () => until("Boolean(window.__prototype) && document.readyState === 'complete'");

  // The mouse and keyboard, through Chrome's own input, so the page gets real events.
  let mouse = { x: WIDTH / 2, y: HEIGHT / 2 };
  const bar = (selector) =>
    `document.querySelector("[data-prototype-overlay]").shadowRoot.querySelector(${JSON.stringify(selector)})`;
  const centreOf = async (element) => {
    const at = await evaluate(
      `(() => { const r = (${element}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`
    );
    if (!at) throw new Error(`Not on the page: ${element}`);
    return at;
  };
  const moveTo = async (to, steps = 12) => {
    const from = mouse;
    for (let i = 1; i <= steps; i++) {
      // Eased, so it reads as a hand moving rather than a jump.
      const t = 1 - (1 - i / steps) ** 3;
      mouse = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      await page("Input.dispatchMouseEvent", { type: "mouseMoved", ...mouse });
      await sleep(25);
    }
  };
  const clickOn = async (element) => {
    await moveTo(await centreOf(element));
    await sleep(200);
    for (const type of ["mousePressed", "mouseReleased"])
      await page("Input.dispatchMouseEvent", { type, ...mouse, button: "left", clickCount: 1 });
  };
  const type = async (text) => {
    for (const char of text) {
      await page("Input.dispatchKeyEvent", { type: "keyDown", key: char, text: char });
      await page("Input.dispatchKeyEvent", { type: "keyUp", key: char });
      await sleep(45);
    }
  };
  const pressEnter = async () => {
    for (const type of ["keyDown", "keyUp"])
      await page("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  };

  // The recording: a screenshot every EVERY_MS, each kept with how long it was on screen.
  fs.rmSync(frames, { recursive: true, force: true });
  fs.mkdirSync(frames, { recursive: true });
  const shots = [];
  let recording = true;
  const recorder = (async () => {
    while (recording) {
      const started = Date.now();
      try {
        // JPEG is quicker to take than PNG, which keeps up with EVERY_MS; a page load costs a frame, not seconds.
        const { data } = await page("Page.captureScreenshot", { format: "jpeg", quality: 92 }, 1000);
        const file = `${String(shots.length + 1).padStart(4, "0")}.jpg`;
        fs.writeFileSync(path.join(frames, file), Buffer.from(data, "base64"));
        shots.push({ file, at: started });
      } catch {
        // A page load in between: no frame this time.
      }
      await sleep(Math.max(0, EVERY_MS - (Date.now() - started)));
    }
  })();

  await page("Page.navigate", { url: origin });
  await player();
  await moveTo({ x: 640, y: 420 }, 1);
  await sleep(300);

  // 1. Play: the flow runs by itself.
  await clickOn(bar("[data-do=play]"));
  await until("__prototype.result().done");
  await sleep(600);

  // 2. The ⚗ panel, and the wrong-code error: it plays there fast and pauses on the message.
  await clickOn(bar("[data-do=controls]"));
  await sleep(400);
  // A native dropdown doesn't draw in a headless screenshot: point at it, then pick, as choosing would.
  await moveTo(await centreOf(bar("[data-do=path]")));
  await sleep(400);
  await evaluate(`(() => {
    const select = ${bar("[data-do=path]")};
    select.value = __prototype.paths[0].id;
    select.dispatchEvent(new Event("change"));
  })()`);
  await sleep(1000);
  await player();
  await until("__prototype.result().paused");
  await sleep(1000);

  // 3. 💬: point at the code boxes, say what should change, send it to Claude.
  await clickOn(bar(".tools [data-do=comment]"));
  await sleep(300);
  await clickOn(`document.querySelector('[aria-label="Code digit 3"]')`);
  await sleep(400);
  await type("Make these boxes bigger");
  await sleep(300);
  await pressEnter();
  await sleep(600);
  await clickOn(bar(".tools [data-do=sendComments]"));

  // 4. Claude answers and resolves it from the command line, as soon as it arrives; the pin picks that
  // up when it next looks (every 3 s). Meanwhile the hand moves off the bar, toward the pin.
  await until(`__prototype.comments()[0]?.status === "open"`);
  const id = await evaluate("__prototype.comments()[0].id");
  for (const args of [
    ["reply", id, "Made the code boxes 48px square, with larger digits."],
    ["resolve", id, "Boxes are 48px now"],
  ])
    spawnSync(process.execPath, [path.join(dot, "comment.mjs"), ...args], {
      env: { ...process.env, COMMENT_BY: "Claude" },
    });
  await moveTo({ x: 640, y: 420 }, 16);
  await until(`__prototype.comments()[0]?.status === "resolved"`, 10_000);
  await sleep(300);
  await clickOn(bar(`[data-pin="${id}"]`));
  await sleep(1800);

  recording = false;
  await recorder;
  cdp.close();

  // ffmpeg's concat list: each frame for as long as it was really on screen; the last one held a beat.
  const lines = shots.flatMap((shot, i) => [
    `file '${shot.file}'`,
    `duration ${(((shots[i + 1]?.at ?? shot.at + 1500) - shot.at) / 1000).toFixed(3)}`,
  ]);
  fs.writeFileSync(path.join(frames, "frames.txt"), [...lines, `file '${shots.at(-1).file}'`, ""].join("\n"));
  const seconds = (shots.at(-1).at + 1500 - shots[0].at) / 1000;
  console.log(`${shots.length} frames, ${seconds.toFixed(1)}s, in ${path.relative(repo, frames)}/`);

  if (spawnSync("ffmpeg", ["-version"]).status === 0) {
    const made = spawnSync("ffmpeg", ffmpegArgs, { cwd: repo, stdio: "inherit" });
    if (made.status !== 0) throw new Error("ffmpeg failed");
    fs.rmSync(frames, { recursive: true, force: true });
    console.log(`${path.relative(repo, gif)}: ${(fs.statSync(gif).size / 1024 / 1024).toFixed(1)} MB`);
  } else {
    const quote = (arg) => (/[\s;[\]]/.test(arg) ? `"${arg}"` : arg);
    console.log(
      `No ffmpeg on the PATH. To make the GIF, from the repo root:\n  ffmpeg ${ffmpegArgs.map(quote).join(" ")}`
    );
  }
} finally {
  chrome.kill();
  stop();
  await sleep(1500);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
