---
name: prototype-controls
description: Put a video-style player on top of a flow someone is building, so they can watch it play through by itself, jump to any step and play its error paths — without touching the flow's code or committing anything. Use when the user runs /prototype-controls, or asks for "prototype controls", "a player on this flow", "autoplay the prototype", "make the flow play like a video", or to watch a flow they built. Vite projects.
---

# Prototype controls

A builder's testing tool. The user has built a flow and wants to **watch it work**: press Play
and see it run step by step, the way a person would use it, then jump to any step or play an
error path. Nothing about it belongs to the flow, so **nothing about it is committed or pushed**:
it lives in a local `.prototype/` folder that git never sees, and it drives the real page from
outside, the way a person would.

| Piece      | File                                   | Job                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The player | `templates/overlay.ts` + `overlay.css` | A floating bar (in its own shadow DOM): play/pause, previous/next chapter, replay, chapter and path, and a ⚗ panel to jump to a chapter or play a path. It plays the script by finding what a person would see (button text, field labels) and clicking and typing into it. It also holds the page's clock: pause freezes the page (timers, `Date.now`, animations), and skipping runs it fast. |
| The script | `templates/script.ts` (an example)     | The flow as chapters: what a person does at each step, plus error paths. You write it for the flow in front of you.                                                                                                                                                                                                                                                                             |
| The hook   | `templates/vite.config.mjs`            | The project's own Vite config, plus a plugin that adds the player first in `<head>`, so its clock is in place before the app's code runs.                                                                                                                                                                                                                                                       |

## Set it up

1. **Read the flow.** Find its routes, its steps in order, and the visible text a person uses at
   each step: button labels, field placeholders or labels, the text that says a step is done.
   Note what it saves (storage keys, sign-in) and any scenario switches it or its mock backend
   already has (a URL param, a mock `/scenario` endpoint) — error paths use those.
2. **Make the local folder.** Create `.prototype/` at the repo root and add `/.prototype/` to
   **`.git/info/exclude`** — never `.gitignore`, which is committed. Copy `templates/overlay.ts`,
   `overlay.css` and `vite.config.mjs` into it unchanged.
3. **Write `.prototype/script.ts`.** One chapter per step a person takes. In each, wait for what
   they'd wait for (`page.waitFor`) and do what they'd do (`page.click("Continue")`,
   `page.type("Work email", …)`). Give `reset` whatever clears the flow's saved state so a
   restart lands on its first page (signed out, if the start page redirects the signed-in).
   A wait the viewer shouldn't sit through (a search that takes minutes) is
   `page.skipUntil(text)`: the page's clock runs fast until it shows, so the flow needs no
   "skip" button of its own. A chapter can set `placement` when the page has something in
   that corner.
4. **Error paths.** Each path overrides the chapters that play differently, by title. Get the
   flow into the error state through what already exists: a `start` URL with the flow's scenario
   param, or a `setup` that sets the mock backend's scenario. Chapters before the error that the
   scenario skips get an empty `run`.
5. **Start it beside the usual dev server.** Read how the project runs dev (`package.json`). Plain
   Vite: `npx vite --config .prototype/vite.config.mjs --port <free port>`. A wrapper that sets
   env or starts a mock backend: write `.prototype/dev.mjs` that does the same with
   `--config .prototype/vite.config.mjs`, on its own ports so it doesn't fight the usual server.
6. **Play it.** Open the page, press Play, and watch the bar. "Waiting for “X”" means the script
   asked for text that isn't on the page: fix the label or the wait, and play again. Check
   previous (it restarts and skips ahead), jump and each path too.
7. **Tell the user** the URL, the command to start it again, and that `git status` doesn't show it.

## Rules

- **Never edit a tracked file for the player.** Not the flow, not the app's config, not
  `.gitignore`. If a path needs a state nothing outside the flow can reach, say so and ask — don't
  add a hook to the flow quietly.
- **Drive the page, don't fake it.** Clicks and typing go through the real UI, so what plays is
  what a person would get. No reaching into the app's state.
- **Scripts read like what a person does.** Labels they'd read, waits for what they'd see.
- **How the controls behave.** Pause freezes the page like a paused video; clicking the page while
  paused hands it back to you. Previous can't wind the page back, so it replays from the start to
  the step before, with the clock fast (seconds). Next finishes the step on screen fast. A reload
  while playing (an edit to the script, a dev-server reload) replays back to the same step.
- Chapters shouldn't span a full page load the flow makes itself: put the click that navigates
  last in its chapter.
- Only `Date.now` and timers are on the player's clock, not `new Date()` or `performance.now`.
  A flow that times itself with those won't speed up or freeze.
- To remove it: delete `.prototype/` and its line in `.git/info/exclude`.

Reference: Recepto's onboarding script plays the website, work email and code, the site read,
customers, signals and the first play, then New Leads' welcome video, first lead and all leads,
with paths opened through the flow's `?path=` scenario param.
