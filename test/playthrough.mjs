// Plays the fixture in a headless Chrome the way SKILL.md section 4 checks a script: replay(), then
// check-wait.js until the player stops. Then opens the error path, and checks that what the studio and
// the review remember survives a reload. Needs a Chrome or Edge (or CHROME_PATH).
//
//   npm test
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect, extraChromeArgs, findChrome } from "../templates/tour.mjs";
import { checks, dot, repo, sleep, startFixture } from "./fixture.mjs";

// check-wait.js is a bare function expression, for a browser tool to call.
const checkWait = fs
  .readFileSync(path.join(repo, "templates/check-wait.js"), "utf8")
  .replace(/^\/\/.*$/gm, "")
  .trim()
  .replace(/;$/, "");

const { origin, stop } = await startFixture(5198);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "prototype-playthrough-"));
const chrome = spawn(
  findChrome(),
  [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--window-size=1280,900",
    ...extraChromeArgs(),
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);
// A failed check leaves the page as it was in shots/, so a broken play-through can be seen (CI uploads it).
let screenshot = async () => null;
const { check, done } = checks(async (name) => {
  const data = await screenshot();
  if (!data) return;
  const file = path.join(dot, "shots", `failed-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`     the page then: ${path.relative(repo, file)}`);
});

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
  const page = (method, params) => cdp.send(method, params, sessionId, 180_000);
  screenshot = async () => (await page("Page.captureScreenshot", { format: "png" })).data;
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await page("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  /** Until `test` holds in the page: a load in progress answers with an error, so keep asking. */
  const until = async (test) => {
    for (let i = 0; i < 150; i++) {
      if (await evaluate(test).catch(() => false)) return;
      await sleep(100);
    }
    throw new Error(`Never true: ${test}`);
  };
  const open = async (url) => {
    await page("Page.navigate", { url });
    await sleep(300);
    await until("document.readyState === 'complete'");
  };
  const reload = async () => {
    await page("Page.reload", {});
    await sleep(300);
    await until("document.readyState === 'complete'");
  };
  const player = () => until("Boolean(window.__prototype) && document.readyState === 'complete'");
  /** Starts something that reloads the page, then waits on the new page until the player stops. */
  const startAndWait = async (action) => {
    await evaluate(action);
    await sleep(800);
    await player();
    return evaluate(`(${checkWait})()`);
  };

  await open(origin);
  await player();

  await check("replay() plays the whole flow to done, on “You're in”", async () => {
    const result = await startAndWait("__prototype.replay()");
    assert.equal(result.waitingFor, null, result.waitingFor);
    assert.equal(result.done, true, JSON.stringify(result));
    assert.equal(result.chapter, "Done");
    assert.equal(await evaluate("document.querySelector('#app').innerText.trim()"), "You're in");
  });

  await check("the wrong-code path pauses with its message on screen", async () => {
    const id = await evaluate("__prototype.paths[0].id");
    const result = await startAndWait(`__prototype.showPath(${JSON.stringify(id)})`);
    assert.equal(result.paused, true, JSON.stringify(result));
    assert.equal(result.onScreen, true, JSON.stringify(result));
    assert.equal(result.chapter, "Code");
    assert.match(await evaluate("document.body.innerText"), /That code doesn't match/);
  });

  await check("Send goes away once the drafts are sent, with the pointer still on it", async () => {
    // Real mouse and keys, so :hover is real: it once kept the hidden button showing "Send 0".
    const bar = (selector) =>
      `document.querySelector("[data-prototype-overlay]").shadowRoot.querySelector(${JSON.stringify(selector)})`;
    const click = async (element) => {
      const at = await evaluate(
        `(() => { const r = (${element}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`
      );
      await page("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
      for (const type of ["mousePressed", "mouseReleased"])
        await page("Input.dispatchMouseEvent", { type, ...at, button: "left", clickCount: 1 });
    };
    const send = bar(".tools [data-do=sendComments]");
    await click(bar(".tools [data-do=comment]"));
    await click(`document.querySelector('[aria-label="Code digit 3"]')`);
    // The editor takes focus a tick after it opens.
    await until(`(() => {
      let el = document.activeElement;
      while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
      return el?.tagName === "TEXTAREA";
    })()`);
    await page("Input.insertText", { text: "Bigger boxes" });
    for (const type of ["keyDown", "keyUp"])
      await page("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await until(`!(${send}).hidden`);
    await click(send);
    assert.equal(await evaluate(`(${send}).matches(":hover")`), true, "the pointer isn't on the button");
    await until(`(${send}).hidden`);
    assert.equal(await evaluate(`getComputedStyle(${send}).display`), "none");
  });

  await check("the player's timing is saved through the file API", async () => {
    const timing = await evaluate("fetch('/__prototype/file?path=timing.json').then((r) => r.ok && r.json())");
    assert.ok(timing && "Welcome" in timing, JSON.stringify(timing));
  });

  await check("the review's ticks and the studio's size survive a reload", async () => {
    // A one-screen tour, saved from the page itself the way the player saves files.
    const run = "2026-01-01T00-00-00";
    const manifest = {
      run,
      at: new Date().toISOString(),
      viewport: "1280 × 900 at 1×",
      shots: [{ name: "01-welcome", kind: "step", title: "Welcome", file: "shots/latest/01-welcome.png", issues: [] }],
    };
    const { data } = await page("Page.captureScreenshot", { format: "png" });
    const saved = await evaluate(`Promise.all([
      fetch("/__prototype/file?path=shots/latest/01-welcome.png", { method: "POST", body: Uint8Array.from(atob(${JSON.stringify(data)}), (c) => c.charCodeAt(0)) }),
      fetch("/__prototype/file?path=shots/latest/manifest.json", { method: "POST", body: ${JSON.stringify(JSON.stringify(manifest))} }),
    ]).then((all) => all.map((r) => r.status))`);
    assert.deepEqual(saved, [200, 200]);

    await open(`${origin}/__prototype/sheet`);
    await until("Boolean(document.querySelector('[data-review]'))");
    await evaluate("document.querySelector('[data-review]').click()");
    await reload();
    await until("Boolean(document.querySelector('.row'))");
    assert.equal(await evaluate("Boolean(document.querySelector('.row.reviewed'))"), true, "the tick was lost");

    await open(`${origin}/__prototype/studio`);
    await until("Boolean(document.querySelector('#width'))");
    await evaluate(`(() => {
      for (const [id, value] of [["width", "390"], ["height", "844"]]) {
        const field = document.querySelector("#" + id);
        field.value = value;
        field.dispatchEvent(new Event("change"));
      }
    })()`);
    await reload();
    await until("Boolean(document.querySelector('#width'))");
    const size = await evaluate("['#width', '#height'].map((id) => document.querySelector(id).value)");
    assert.deepEqual(size, ["390", "844"]);
  });

  cdp.close();
} finally {
  chrome.kill();
  stop();
  // Chrome lets go of its profile a moment after it exits.
  await sleep(1500);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
done();
