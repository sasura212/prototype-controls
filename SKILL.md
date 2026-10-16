---
name: prototype-controls
description: Put a video-style player on top of a flow someone is building, so they can watch it play through by itself, jump to any step, see every error state, comment on anything (comments come to you to act on), record it, and screenshot every step for review — fully automatic, without touching the flow's code or committing anything. Use when the user runs /prototype-controls, or asks for "prototype controls", "a player on this flow", "autoplay the prototype", "show me all the error states", "make the flow play like a video", "let me comment on the flow", or to watch a flow they built. Vite projects.
---

# Prototype controls

A builder's testing tool. The user has built a flow and wants to **watch it work**: press Play and
see it run step by step the way a person would use it, jump to any step, open any error state to
read its message, and **comment on anything they see, for you to act on**. Nothing about it belongs
to the flow, so **nothing about it is committed or pushed**: it lives in a local `.prototype/`
folder that git never sees, and it drives the real page from outside.

**This is fully automatic.** The user runs the command and gets a working player: you map the
flow and its error states yourself, write the script, start it, check every step and every error
in a browser, fix what doesn't play, start watching for their comments, and hand over the URL.
Don't ask questions you can answer from the code. If they named a flow, use it; if not, take the
flow they're working on (the branch's recent changes, the route they last touched).

## What's in `templates/`

| File                         | Job                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `overlay.ts` + `overlay.css` | The player bar, in its own shadow DOM: dragged anywhere by its grip (remembered), or minimized to a round button with a progress ring. Play/pause, previous/next, replay, 💬 comments, and a ⚗ panel: jump to a step, the errors list, "What if" scenarios, speed (0.5–4×), "Check this screen", timing, and suggestions when a step is stuck. It holds the page's clock: pause freezes the page (timers, `Date.now`, CSS animations), speed and skipping run it slower or faster. |
| `checks.ts`                  | "Check this screen": controls with no name, images with no alt, fields with no label, low contrast, and words the style guide rules out.                                                                                                                                                                                                                                                                                                                                           |
| `comments.ts`                | 💬 mode: pick anything on the page, write what should change. Pins show comments and the agent's replies.                                                                                                                                                                                                                                                                                                                                                                          |
| `comment.mjs`                | The comments' store (`.prototype/comments.jsonl`) and its command line: `list`, `show`, `reply`, `resolve`, `reopen`, `watch`.                                                                                                                                                                                                                                                                                                                                                     |
| `studio.html` + `studio.ts`  | `/__prototype/studio`: the flow in a frame sized by dragging its edges, typing a size, or picking a device (scaled down when bigger than the window), ● Record (MP4/WebM), and 📸 a tour that screenshots every step and error, compares each with the last tour, and runs the checks.                                                                                                                                                                                             |
| `tour.mjs`                   | The screenshot tour: a headless Chrome of its own (Node 22+, any installed Chrome or Edge, or `CHROME_PATH`) walks the flow through the player and takes a real screenshot of every step and error at 2× density. The studio's 📸 starts it; run it yourself with `node .prototype/tour.mjs <dev server URL> [--width 1440 --height 900 --scale 2]`.                                                                                                                               |
| `sheet.html` + `sheet.ts`    | `/__prototype/sheet`: the flow review. Each screen from the last tour, large, with before/after (side by side, slider, changes marked), the checks, its comments and timing; filters, review ticks, and a grid.                                                                                                                                                                                                                                                                    |
| `vite.config.mjs`            | The project's own Vite config, plus the player first in `<head>` (so its clock is in place before the app runs) and the small API that saves into `.prototype/`.                                                                                                                                                                                                                                                                                                                   |
| `check-wait.js`              | Evaluated in the page by a browser tool: waits until the player stops and says where.                                                                                                                                                                                                                                                                                                                                                                                              |
| `script.ts`                  | An example script. You write the real one for the flow.                                                                                                                                                                                                                                                                                                                                                                                                                            |

## 1. Map the flow

Read the flow's code end to end (routes, the page components, the components each step renders)
and write down, for each step a person takes, in order:

- what they see that says the step is ready (a heading, a question);
- what they do: the exact visible text of buttons, and the placeholder, label or aria-label of fields;
- what they wait for after (a result, a navigation), and how long it can take.

Note what the flow saves between visits (storage keys, sign-in) and whether its start page
redirects someone signed in: `reset` has to undo both.

## 2. Map the error states

Find **every** error and edge state the flow can show, from the code:

- error and empty-state strings in its components (banners, inline field errors, toasts, empty lists);
- failure branches: `catch` blocks, `isError`, error props, status checks, retry buttons;
- what triggers each: bad input a person can type (a malformed URL, a personal email), a backend
  answer, a timeout;
- what already exists to reach the ones a person can't type their way into: a scenario switch in
  the flow (a URL param, a dev flag) or in its mock backend (a `/scenario` endpoint, an env var).

For each, record its message (a short, distinctive piece of the visible text), the step it
happens at, and how to reach it. One a person can cause, the script causes (types the bad email).
One that needs the backend uses the existing switch (`start` URL or `setup`). **One that nothing
outside the flow can reach is listed in `unreachable` with the reason, not hacked in**: never add
a hook to the flow's code.

## 3. Set it up

1. Create `.prototype/` at the repo root and add `/.prototype/` to **`.git/info/exclude`** (never
   `.gitignore`, which is committed). Copy every file in `templates/` except `script.ts` unchanged.
2. Write `.prototype/script.ts` from the two maps:
   - one chapter per step, each waiting for what a person waits for (`page.waitFor`) and doing what
     they do (`page.click("Continue")`, `page.type("Work email", …)`). A wait nobody should sit
     through (a search that takes minutes) is `page.skipUntil(text)`. Something that only drags
     when skipping ahead can step aside with `if (page.isSkipping()) return;`. A chapter sets
     `placement` when the page has something in that corner.
   - one path per error, labelled "Step · what went wrong", with `at` (the chapter the flow is on
     when it opens), `shows` (its message), `start`/`setup` if it needs a switch, and `chapters`
     overriding the steps that go differently: cause the error, `waitFor` its message, `wait` a
     few seconds, then get past it the way a person would. Steps the path skips past, or that no
     longer apply after the error, get an empty `run`.
   - `unreachable`: the errors found that nothing outside the flow can reach, each with why.
   - `scenarios`: if the mock backend has switches (slow, empty, failing), one per switch.
   - `wording`: if the project has a style guide, the words it rules out, each with why.
   - `reset`: clear what the flow saved, and sign out if the start page needs it.
3. Start a dev server with the player, beside the usual one. Read how the project runs dev
   (`package.json`). Plain Vite: `npx vite --config .prototype/vite.config.mjs --port <free port>`.
   A wrapper that sets env or starts a mock backend: write `.prototype/dev.mjs` that does the same
   with `--config .prototype/vite.config.mjs`, on its own ports.

## 4. Check it plays, and fix it

Open the page in whatever browser tool there is (Chrome DevTools, Playwright, Claude in Chrome).
If none can reach localhost, start a headless Chromium yourself with `--headless=new
--remote-debugging-port=9222 --user-data-dir=<scratch dir>` (add `--auto-accept-this-tab-capture`
to test the studio) and use the DevTools tools against it.

The player exposes `window.__prototype`: `chapters`, `paths`, `play()`, `pause()`, `goTo(n)`,
`showPath(id)`, `replay()`, `restart()`, `setRate(n)`, `setHidden(b)`, `audit()`, `timings()`,
`comments()` and `result()`. After each action, evaluate `.prototype/check-wait.js` (it waits in
real time, since the page's clock may be frozen) and read the result. An action that reloads the
page ends the evaluation it ran in: start it in one call, wait in the next.

- **The whole flow:** `replay()`, then wait until `done`. If it reports `waitingFor`, the script
  asked for text that isn't there: look at the page, fix the label or the wait, and play again.
- **Every error:** `showPath(id)` for each path, then wait until `paused`. Check `onScreen` is true
  and take a screenshot: the message should be readable. Then `play()` and check it gets past it.
- **Previous and pause:** `goTo` back one step lands there paused; `pause()` freezes the page.
- **A tour:** `node .prototype/tour.mjs <URL>` screenshots every step and error; open `/__prototype/sheet`
  and look at each screen. A tour that stops or comes out wrong points at the step or path to fix.

Editing `script.ts` reloads the page; the player stops and offers to go back to where it was. Keep
going until the whole flow and every reachable error pass.

## 5. Watch for comments, and act on them

Comments are the user telling you what to change, from the page itself. Start following them before
you hand over, and keep following them for the rest of the session:

- **Claude Code:** run `node .prototype/comment.mjs watch` under the **Monitor** tool. Each comment
  the user posts arrives as an event: `c3 [open] Work email: “…” on “Send me a code”`, and so does
  each reply they write on a thread: `c3 reply from you: “…”`.
- **Any other agent:** tail `.prototype/comments.jsonl` (one JSON event per line), or poll
  `node .prototype/comment.mjs list --open`.

For each comment: `node .prototype/comment.mjs show <id>` gives the step, the element (selector,
its text, a slice of its HTML) and the thread. Find the code (search for the element's text), make
the change in the flow, then `COMMENT_BY=Claude node .prototype/comment.mjs reply <id> "what you
changed"` and `resolve <id>` once it's done. The reply and the resolution show on the comment's pin
in the browser. If a comment is a question or needs a decision, reply with the question instead of
guessing. Comments are about the flow; the player itself is never the thing to change unless the
comment says so.

## 6. Hand over

Tell the user: the URL, the studio (`/__prototype/studio`) and flow review
(`/__prototype/sheet`), the command to start it again, what plays, the errors in the ⚗ panel, any
error it couldn't reach and why, that 💬 comments come to you and you're watching for them, and
that `git status` doesn't show any of it.

## Rules

- **Never edit a tracked file for the player.** Not the flow, not the app's config, not `.gitignore`.
- **Drive the page, don't fake it.** Clicks and typing go through the real UI, so what plays is
  what a person gets. No reaching into the app's state.
- **How the controls behave.** Pause freezes the page like a paused video; clicking the page while
  paused hands it back to the user. Previous can't wind the page back, so it replays from the start
  to the step before, fast. Next finishes the step on screen fast. Picking an error plays fast to
  its message, lets it settle, and pauses there; Play carries on from it. Arriving at a step paused
  lets the screen settle before freezing. A reload while playing (an edit to the script, a dev-server reload) doesn't race off: the player stops at the top and offers "back to <step>" in one click. The speed shows on the bar whenever it isn't 1×, and a `skipUntil` wait says "Fast-forwarding to …".
- **A stuck step offers look-alikes.** When a label isn't found, the panel lists what's on screen
  that looks like it; picking one saves it to `.prototype/aliases.json`. When you see that file,
  fold the aliases into the script and delete them.
- **The tour's "changed" is against the last tour**, and live content or animations can move a few
  percent between runs: the sheet calls under 5% a slight change.
- A chapter shouldn't span a full page load the flow makes itself: put the navigating click last.
- Only `Date.now`, timers, animation frames and CSS animations are on the player's clock, not
  `new Date()` or `performance.now`.
- Recording captures the tab with the browser's screen-share prompt, once per session. Screenshots don't: `tour.mjs` takes them in its own headless Chrome, sharp at 2×, so a tour needs no one at the browser.
- To remove it: delete `.prototype/` and its line in `.git/info/exclude`.
