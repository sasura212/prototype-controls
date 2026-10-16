// Local only (.git/info/exclude). The project's own Vite config, with the prototype player added to
// the page. Run Vite with `--config .prototype/vite.config.mjs` instead of its usual config.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadConfigFromFile, mergeConfig } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default defineConfig(async (env) => {
  const own = await loadConfigFromFile(env, undefined, root);
  return mergeConfig(own?.config ?? {}, {
    // Its own dependency cache, so it can run beside the project's usual dev server without upsetting it.
    cacheDir: path.join(root, "node_modules/.vite-prototype"),
    plugins: [
      {
        name: "prototype-overlay",
        apply: "serve",
        transformIndexHtml: () => [
          {
            tag: "script",
            attrs: { type: "module", src: "/.prototype/overlay.ts" },
            injectTo: "head-prepend",
          },
        ],
      },
    ],
  });
});
