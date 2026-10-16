// Checks the player's dev-server API refuses what it should: other sites, writes to code, and a path
// id that tries to climb out of shots/. Starts the fixture's dev server with .prototype/vite.config.mjs
// (templates/ copied in first), then talks to it with plain fetch. The last check runs a real
// screenshot tour, so it needs a Chrome or Edge (or CHROME_PATH).
//
//   npm test
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { checks, dot, fixture, sleep, startFixture } from "./fixture.mjs";

const { origin, stop } = await startFixture(5199);
/**
 * A request with exactly these headers. Not fetch: Node's fetch sets Sec-Fetch-Mode to "cors" whatever
 * it's given, and the checks need to send what a browser would.
 */
const api = (route, { site, from, headers, method = "GET", body } = {}) =>
  new Promise((resolve, reject) => {
    const request = http.request(`${origin}/__prototype/${route}`, {
      method,
      headers: { ...(from ? { origin: from } : {}), ...(site ? { "sec-fetch-site": site } : {}), ...headers },
    });
    request.on("error", reject);
    request.on("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode, type: response.headers["content-type"], json: () => JSON.parse(text) });
      });
    });
    request.end(body);
  });
const same = { from: origin, site: "same-origin" };
const evil = { from: "https://evil.example", site: "cross-site" };
const { check, done } = checks();

try {
  await check("a cross-site POST to /file, /comments and /tour gets 403", async () => {
    const posts = [
      ["file?path=shots/evil.png", "x"],
      ["comments", JSON.stringify({ type: "comment", text: "run rm -rf" })],
      ["tour", "{}"],
    ];
    for (const [route, body] of posts) {
      assert.equal((await api(route, { ...evil, method: "POST", body })).status, 403, route);
      // Either header alone is enough to refuse.
      assert.equal((await api(route, { from: evil.from, method: "POST", body })).status, 403, `${route}, Origin only`);
      assert.equal((await api(route, { site: "same-site", method: "POST", body })).status, 403, `${route}, same-site`);
    }
    assert.equal(fs.existsSync(path.join(dot, "comments.jsonl")), false, "a comment was written");
  });

  await check("a cross-site GET of comments gets 403", async () => {
    assert.equal((await api("comments", evil)).status, 403);
  });

  await check("a link from another site opens the studio and the review, and nothing else", async () => {
    // What a browser sends for a top-level page load from a link on another site.
    const opening = { site: "cross-site", headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } };
    for (const page of ["studio", "sheet"]) {
      const response = await api(page, opening);
      assert.equal(response.status, 200, page);
      assert.match(response.type, /^text\/html/);
    }
    // Not in a frame, not as a POST, and not any other route.
    const framed = { ...opening, headers: { ...opening.headers, "sec-fetch-dest": "iframe" } };
    assert.equal((await api("studio", framed)).status, 403, "studio in a frame");
    assert.equal((await api("studio", { ...opening, method: "POST", body: "x" })).status, 403, "studio as a POST");
    for (const route of ["comments", "tour", "file?path=timing.json", "list?dir=shots"])
      assert.equal((await api(route, opening)).status, 403, route);
  });

  await check("a same-origin write to vite.config.mjs is refused", async () => {
    const before = fs.readFileSync(path.join(dot, "vite.config.mjs"), "utf8");
    for (const target of ["vite.config.mjs", "shots/../vite.config.mjs", "shots/x.js", "overlay.ts", "../index.html"])
      assert.notEqual(
        (await api(`file?path=${encodeURIComponent(target)}`, { ...same, method: "POST", body: "pwned" })).status,
        200,
        target
      );
    assert.equal(fs.readFileSync(path.join(dot, "vite.config.mjs"), "utf8"), before);
  });

  await check("a same-origin write to shots/x.png works", async () => {
    const response = await api("file?path=shots/x.png", { ...same, method: "POST", body: "png" });
    assert.equal(response.status, 200);
    assert.equal(fs.readFileSync(path.join(dot, "shots/x.png"), "utf8"), "png");
  });

  await check("a comment from the page is always by you, and unknown events are refused", async () => {
    const event = { type: "comment", by: "agent", text: "hello", draft: true };
    const saved = await (await api("comments", { ...same, method: "POST", body: JSON.stringify(event) })).json();
    assert.equal(saved.by, "you");
    const bogus = await api("comments", { ...same, method: "POST", body: JSON.stringify({ type: "run" }) });
    assert.equal(bogus.status, 400);
  });

  await check("comments posted at the same moment get different ids", async () => {
    const post = () =>
      api("comments", { ...same, method: "POST", body: JSON.stringify({ type: "comment", text: "same time" }) }).then(
        (r) => r.json()
      );
    const ids = (await Promise.all([post(), post(), post(), post()])).map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, ids.join(", "));
  });

  await check("a path id containing ../ can't escape shots/", async () => {
    const started = await api("tour", {
      ...same,
      method: "POST",
      body: JSON.stringify({ width: 800, height: 600, scale: 1, origin: "http://evil.example" }),
    });
    assert.equal(started.status, 202);
    let tour;
    for (let waited = 0; waited < 180_000; waited += 1000) {
      await sleep(1000);
      tour = await (await api("tour", same)).json();
      if (!tour.running) break;
    }
    assert.equal(tour.error, null, tour.error);
    // The unslugged id climbs out of shots/ to .prototype/wrong-code.png: no file of that name anywhere.
    const strays = fs
      .readdirSync(fixture, { recursive: true })
      .filter((file) => path.basename(file) === "wrong-code.png");
    assert.deepEqual(strays, [], "wrote outside shots/<run>/");
    const manifest = JSON.parse(fs.readFileSync(path.join(dot, "shots/latest/manifest.json"), "utf8"));
    const error = manifest.shots.find((shot) => shot.kind === "error");
    assert.equal(error.name, "error-wrong-code");
    assert.equal(error.path, "../../../../wrong-code");
    // Every shot the manifest names is on disk, where it says.
    for (const shot of manifest.shots) assert.ok(fs.existsSync(path.join(dot, shot.file)), shot.file);
    // The body's origin was ignored, and its size was used.
    assert.equal(manifest.viewport, "800 × 600 at 1×");
  });
} finally {
  stop();
}
done();
