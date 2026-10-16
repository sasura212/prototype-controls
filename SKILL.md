---
name: prototype-controls
description: Put a video-style player on top of a flow someone is building, so they can watch it play through by itself, jump to any step and see every error state — fully automatic, without touching the flow's code or committing anything. Use when the user runs /prototype-controls, or asks for "prototype controls", "a player on this flow", "autoplay the prototype", "show me all the error states", "make the flow play like a video", or to watch a flow they built. Vite projects.
---

# Prototype controls

A builder's testing tool. The user has built a flow and wants to **watch it work**: press Play and
see it run step by step the way a person would use it, jump to any step, and open any error state
to read its message. Nothing about it belongs to the flow, so **nothing about it is committed or
pushed**: it lives in a local `.prototype/` folder that git never sees, and it drives the real page
from outside.

**This is fully automatic.** The user runs the command and gets a working player: you map the
flow and its error states yourself, write the script, start it, check every step and every error
in a browser, fix what doesn't play, and hand over the URL. Don't ask questions you can answer
from the code. If they named a flow, use it; if not, take the flow they're working on (the
branch's recent changes, the route they last touched).

| Piece      | File                                   | Job                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The player | `templates/overlay.ts` + `overlay.css` | A floating bar (in its own shadow DOM): play/pause, previous/next step, replay, and a ⚗ panel to jump to a step or open an error. It plays the script by finding what a person sees (button text, field labels) and clicking and typing into it. It holds the page's clock: pause freezes the page (timers, `Date.now`, animations), skipping runs it fast. |
| The script | `templates/script.ts` (an example)     | The flow as chapters, plus its error paths. You write it for the flow in front of you.                                                                                                                                                                                                                                                                      |
| The hook   | `templates/vite.config.mjs`            | The project's own Vite config, plus a plugin that adds the player first in `<head>`, so its clock is in place before the app's code runs.                                                                                                                                                                                                                   |
| The check  | `templates/check-wait.js`              | Evaluated in the page by a browser tool: waits until the player stops and reports where.                                                                                                                                                                                                                                                                    |

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
outside the flow can reach is reported, not hacked in**: never add a hook to the flow's code.

## 3. Set it up

1. Create `.prototype/` at the repo root and add `/.prototype/` to **`.git/info/exclude`** (never
   `.gitignore`, which is committed). Copy `overlay.ts`, `overlay.css`, `vite.config.mjs` and `check-wait.js` from
   `templates/` unchanged.
2. Write `.prototype/script.ts` from the two maps:
   - one chapter per step, each waiting for what a person waits for (`page.waitFor`) and doing what
     they do (`page.click("Continue")`, `page.type("Work email", …)`). A wait nobody should sit
     through (a search that takes minutes) is `page.skipUntil(text)`. Something that only drags
     when skipping ahead (a video) can step aside with `if (page.isSkipping()) return;`. A chapter
     sets `placement` when the page has something in that corner.
   - one path per error, labelled "Step · what went wrong", with `at` (the chapter the flow is on
     when it opens), `shows` (its message), `start`/`setup` if it needs a switch, and `chapters`
     overriding the steps that go differently: cause the error, `waitFor` its message, `wait` a
     few seconds, then get past it the way a person would ("Try again", the right code). Steps the
     path skips past, or that no longer apply after the error, get an empty `run`.
   - `reset`: clear what the flow saved, and sign out if the start page needs it.
3. Start a dev server with the player, beside the usual one. Read how the project runs dev
   (`package.json`). Plain Vite: `npx vite --config .prototype/vite.config.mjs --port <free port>`.
   A wrapper that sets env or starts a mock backend: write `.prototype/dev.mjs` that does the same
   with `--config .prototype/vite.config.mjs`, on its own ports.

## 4. Check it plays, and fix it

Open the page in whatever browser tool there is (Chrome DevTools, Playwright, Claude in Chrome).
If none can reach localhost, start a headless Chromium yourself with `--headless=new
--remote-debugging-port=9222 --user-data-dir=<scratch dir>` (Playwright's download, or the
installed Chrome) and use the DevTools tools against it.

The player exposes `window.__prototype` for this: `chapters`, `paths`, `play()`, `pause()`,
`goTo(n)`, `showPath(id)`, `replay()` and `result()`. After each action, evaluate
`.prototype/check-wait.js` (it waits in real time, since the page's clock may be frozen) and read
the result. An action that reloads the page ends the evaluation it ran in: start it in one call,
wait in the next.

- **The whole flow:** `replay()`, then wait until `done`. If it reports `waitingFor`, the script
  asked for text that isn't there: look at the page, fix the label or the wait, and play again.
- **Every error:** `showPath(id)` for each path, then wait until `paused`. Check `onScreen` is true
  and take a screenshot: the message should be readable. Then `play()` and check it gets past it.
- **Previous and pause:** `goTo` back one step lands there paused; `pause()` freezes the page.

Editing `script.ts` reloads the page; the player replays to where it was. Keep going until the
whole flow and every reachable error pass.

## 5. Hand over

Tell the user: the URL, the command to start it again, what plays, the list of errors in the ⚗
panel, any error it couldn't reach and why, and that `git status` doesn't show any of it.

## Rules

- **Never edit a tracked file for the player.** Not the flow, not the app's config, not `.gitignore`.
- **Drive the page, don't fake it.** Clicks and typing go through the real UI, so what plays is
  what a person gets. No reaching into the app's state.
- **How the controls behave.** Pause freezes the page like a paused video; clicking the page while
  paused hands it back to the user. Previous can't wind the page back, so it replays from the start
  to the step before, fast. Next finishes the step on screen fast. Picking an error plays fast to
  its message, lets it settle, and pauses there; Play carries on from it. A reload while playing
  replays back to the same step.
- A chapter shouldn't span a full page load the flow makes itself: put the navigating click last.
- Only `Date.now` and timers are on the player's clock, not `new Date()` or `performance.now`.
- To remove it: delete `.prototype/` and its line in `.git/info/exclude`.
