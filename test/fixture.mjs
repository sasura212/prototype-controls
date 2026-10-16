// The fixture app with the player on it, as the skill sets it up: every template except the example
// script copied into test/fixture/.prototype/, then Vite started with .prototype/vite.config.mjs.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const fixture = path.join(repo, "test/fixture");
export const dot = path.join(fixture, ".prototype");
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts the fixture's dev server on `port` from a clean .prototype/. Resolves once it answers. */
export const startFixture = async (port) => {
  for (const file of fs.readdirSync(path.join(repo, "templates")))
    if (file !== "script.ts") fs.copyFileSync(path.join(repo, "templates", file), path.join(dot, file));
  for (const leftover of ["shots", "comments.jsonl", "timing.json", "aliases.json", "wrong-code.png"])
    fs.rmSync(path.join(dot, leftover), { recursive: true, force: true });
  const server = spawn(
    process.execPath,
    [
      path.join(repo, "node_modules/vite/bin/vite.js"),
      "--config",
      ".prototype/vite.config.mjs",
      "--port",
      String(port),
      "--strictPort",
    ],
    { cwd: fixture, stdio: ["ignore", "ignore", "inherit"] }
  );
  const origin = `http://localhost:${port}`;
  for (let i = 0; !(await fetch(origin).catch(() => null))?.ok; i++) {
    if (i > 100) {
      server.kill();
      throw new Error("The dev server didn't start");
    }
    await sleep(200);
  }
  return { origin, stop: () => server.kill() };
};

/** Counts and prints each check; `done()` exits non-zero if any failed. `onFail` hears each failure's name. */
export const checks = (onFail = async () => {}) => {
  let failed = 0;
  const check = async (name, test) => {
    try {
      await test();
      console.log(`ok   ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL ${name}\n     ${error.message}`);
      await onFail(name).catch(() => undefined);
    }
  };
  const done = () => {
    console.log(failed ? `\n${failed} failed` : "\nAll passed");
    process.exit(failed ? 1 : 0);
  };
  return { check, done };
};
