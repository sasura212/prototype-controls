// Local only (.git/info/exclude). The project's own Vite config, with the prototype player added to
// the page. Run Vite with `--config .prototype/vite.config.mjs` instead of its usual config.
//
// It also serves the player's own pages and saves what the player makes, all inside `.prototype/`:
//   /__prototype/studio       the app in a frame: viewport sizes, recording, the screenshot tour
//   /__prototype/sheet        the flow review from the last screenshot tour
//   /__prototype/comments     GET the comments, POST a comment, reply, resolve (see comment.mjs)
//   /__prototype/tour         POST to start the screenshot tour (tour.mjs), GET its progress
//   /__prototype/file?path=   GET a file under .prototype/; POST one into shots/, recordings/, timing.json
//                             or aliases.json (never code)
//   /__prototype/list?dir=    the files in a folder under .prototype/
// Every route answers only the page itself (same origin): another site gets a 403. The one exception is
// opening the studio or the review as a page (a top-level navigation), say from a link.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineConfig, loadConfigFromFile, mergeConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

/** A path inside `.prototype/`, refusing anything that would land outside it. */
const inside = (relative) => {
  const full = path.resolve(here, relative ?? "");
  if (full !== here && !full.startsWith(here + path.sep)) throw new Error("Outside .prototype/");
  return full;
};
const body = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
const send = (res, status, data, type = "application/json") => {
  res.statusCode = status;
  res.setHeader("content-type", type);
  res.setHeader("cache-control", "no-store");
  // Objects are answers from here, to serialise; files arrive as Buffers and go out as they are.
  res.end(Buffer.isBuffer(data) || typeof data === "string" ? data : JSON.stringify(data));
};
const TYPES = { ".png": "image/png", ".webm": "video/webm", ".mp4": "video/mp4", ".json": "application/json" };

/**
 * Only this page may use the API. Another site can still send a "simple" POST here (it just can't read
 * the answer), and a write here can change the config Vite runs or put words in the agent's mouth.
 */
const isFromHere = (req) => {
  const site = req.headers["sec-fetch-site"];
  if (site === "cross-site" || site === "same-site") return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
};
/**
 * Opening the studio or the review from a link elsewhere is fine: a top-level page load (never a frame,
 * never a POST) gets the page, and everything that page then asks for comes from here.
 */
const isPageOpen = (req, route) =>
  req.method === "GET" &&
  (route === "studio" || route === "sheet") &&
  req.headers["sec-fetch-mode"] === "navigate" &&
  req.headers["sec-fetch-dest"] === "document";
/** What the player, the studio and the tour save: screenshots, recordings, timing, renamed labels. Never code. */
const isWritable = (file) => {
  const relative = path.relative(here, file).split(path.sep).join("/");
  if (/\.(m?[jt]s|c[jt]s|[jt]sx|html?|css)$/i.test(relative)) return false;
  return /^(shots|recordings)\/./.test(relative) || relative === "timing.json" || relative === "aliases.json";
};
/** A number from the request, kept in a sane range; anything else is the fallback. */
const clamp = (value, min, max, fallback) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
const EVENTS = new Set(["comment", "send", "edit", "delete", "reply", "resolve", "reopen"]);
/** Comment posts one at a time: the next id is read, then appended, and two at once would share it. */
let commentQueue = Promise.resolve();
const oneAtATime = (task) => {
  const result = commentQueue.then(task);
  commentQueue = result.catch(() => undefined);
  return result;
};

// Loaded when the server starts, not bundled with this config: it finds its file from its own location.
const comments = () => import(pathToFileURL(path.join(here, "comment.mjs")).href);
const tours = () => import(pathToFileURL(path.join(here, "tour.mjs")).href);
/** The screenshot tour in progress (one at a time), for the studio to show. */
let tour = { running: false, done: 0, total: 0, label: "", error: null, run: null };

const api = async (req, res, next) => {
  const url = new URL(req.url ?? "/", "http://local");
  if (!url.pathname.startsWith("/__prototype/")) return next();
  const route = url.pathname.slice("/__prototype/".length);
  if (!isFromHere(req) && !isPageOpen(req, route))
    return send(res, 403, { error: "Only the player's own page can use this" });
  try {
    if (route === "studio" || route === "sheet") {
      return send(res, 200, fs.readFileSync(path.join(here, `${route}.html`)), "text/html");
    }
    if (route === "comments") {
      const { append, fold, nextId, readEvents } = await comments();
      if (req.method === "GET") return send(res, 200, fold(readEvents()));
      const event = JSON.parse((await body(req)).toString("utf8"));
      if (!EVENTS.has(event?.type)) return send(res, 400, { error: `Unknown event type ${event?.type}` });
      // Whatever the page says, a post from the browser is the person: only comment.mjs speaks as the agent.
      return send(
        res,
        200,
        await oneAtATime(() =>
          append({ ...event, by: "you", id: event.type === "comment" ? nextId(readEvents()) : event.id })
        )
      );
    }
    if (route === "tour") {
      if (req.method === "GET") return send(res, 200, tour);
      if (tour.running) return send(res, 409, tour);
      const asked = JSON.parse((await body(req)).toString("utf8") || "{}");
      // Only the size comes from the page; where Chrome goes is always this server.
      const options = {
        width: clamp(asked?.width, 200, 4000, 1440),
        height: clamp(asked?.height, 200, 4000, 900),
        scale: clamp(asked?.scale, 1, 3, 2),
      };
      const { runTour } = await tours();
      tour = { running: true, done: 0, total: 0, label: "Starting Chrome", error: null, run: null };
      runTour({ ...options, origin: `http://${req.headers.host}`, onProgress: (p) => Object.assign(tour, p) }).then(
        (manifest) => Object.assign(tour, { running: false, run: manifest.run }),
        (error) => Object.assign(tour, { running: false, error: String(error?.message ?? error) })
      );
      return send(res, 202, tour);
    }
    if (route === "file") {
      const file = inside(url.searchParams.get("path"));
      if (req.method === "POST") {
        if (!isWritable(file)) return send(res, 403, { error: `Can't write ${url.searchParams.get("path")}` });
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, await body(req));
        return send(res, 200, { saved: path.relative(root, file) });
      }
      if (!fs.existsSync(file)) return send(res, 404, { missing: true });
      return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] ?? "application/octet-stream");
    }
    if (route === "list") {
      const dir = inside(url.searchParams.get("dir"));
      return send(res, 200, fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
    }
    return send(res, 404, { unknown: route });
  } catch (error) {
    return send(res, 400, { error: String(error?.message ?? error) });
  }
};

export default defineConfig(async (env) => {
  const own = await loadConfigFromFile(env, undefined, root);
  return mergeConfig(own?.config ?? {}, {
    // Its own dependency cache, so it can run beside the project's usual dev server without upsetting it.
    cacheDir: path.join(root, "node_modules/.vite-prototype"),
    // What the player writes into .prototype/ (screenshots, comments) isn't a reason to reload the page.
    server: { watch: { ignored: ["**/.prototype/shots/**", "**/.prototype/recordings/**", "**/.prototype/*.json*"] } },
    plugins: [
      {
        name: "prototype-overlay",
        apply: "serve",
        // A block, not an expression: a function returned from here would run as a hook of its own.
        configureServer: (server) => {
          server.middlewares.use(api);
        },
        transformIndexHtml: () => [
          { tag: "script", attrs: { type: "module", src: "/.prototype/overlay.ts" }, injectTo: "head-prepend" },
        ],
      },
    ],
  });
});
