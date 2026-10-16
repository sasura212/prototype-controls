// Local only (.git/info/exclude). The project's own Vite config, with the prototype player added to
// the page. Run Vite with `--config .prototype/vite.config.mjs` instead of its usual config.
//
// It also serves the player's own pages and saves what the player makes, all inside `.prototype/`:
//   /__prototype/studio       the app in a frame: viewport sizes, recording, the screenshot tour
//   /__prototype/sheet        the flow review from the last screenshot tour
//   /__prototype/comments     GET the comments, POST a comment, reply, resolve (see comment.mjs)
//   /__prototype/tour         POST to start the screenshot tour (tour.mjs), GET its progress
//   /__prototype/file?path=   GET or POST a file under .prototype/ (screenshots, recordings, reports)
//   /__prototype/list?dir=    the files in a folder under .prototype/
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

// Loaded when the server starts, not bundled with this config: it finds its file from its own location.
const comments = () => import(pathToFileURL(path.join(here, "comment.mjs")).href);
const tours = () => import(pathToFileURL(path.join(here, "tour.mjs")).href);
/** The screenshot tour in progress (one at a time), for the studio to show. */
let tour = { running: false, done: 0, total: 0, label: "", error: null, run: null };

const api = async (req, res, next) => {
  const url = new URL(req.url ?? "/", "http://local");
  if (!url.pathname.startsWith("/__prototype/")) return next();
  try {
    const route = url.pathname.slice("/__prototype/".length);
    if (route === "studio" || route === "sheet") {
      return send(res, 200, fs.readFileSync(path.join(here, `${route}.html`)), "text/html");
    }
    if (route === "comments") {
      const { append, fold, nextId, readEvents } = await comments();
      if (req.method === "GET") return send(res, 200, fold(readEvents()));
      const event = JSON.parse((await body(req)).toString("utf8"));
      const id = event.type === "comment" ? nextId(readEvents()) : event.id;
      return send(res, 200, append({ ...event, id }));
    }
    if (route === "tour") {
      if (req.method === "GET") return send(res, 200, tour);
      if (tour.running) return send(res, 409, tour);
      const options = JSON.parse((await body(req)).toString("utf8") || "{}");
      const { runTour } = await tours();
      tour = { running: true, done: 0, total: 0, label: "Starting Chrome", error: null, run: null };
      runTour({ origin: `http://${req.headers.host}`, ...options, onProgress: (p) => Object.assign(tour, p) }).then(
        (manifest) => Object.assign(tour, { running: false, run: manifest.run }),
        (error) => Object.assign(tour, { running: false, error: String(error?.message ?? error) })
      );
      return send(res, 202, tour);
    }
    if (route === "file") {
      const file = inside(url.searchParams.get("path"));
      if (req.method === "POST") {
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
