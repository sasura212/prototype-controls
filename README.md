# prototype-controls

A Claude Code skill that puts a video-style player on top of a flow you're building, so you can
watch it work, see every error state, and comment on anything for Claude to fix.

Run `/prototype-controls` on a flow and Claude adds a dark player bar to the page.

**Watch it**

- **Play** runs the flow by itself, step by step, at a person's pace: it types into the real
  fields and clicks the real buttons. Long waits (a search that takes minutes) go by fast.
- **Pause** freezes the page like a paused video: timers, animations, everything.
- **Previous / next** move a step. **Replay** starts over. **Speed** goes from 0.5× to 4×.
- **Drag** the bar anywhere by its grip; it stays there. Double-click the grip to put it back.
  **Minimize** shrinks it to a round button with a progress ring.

**See every state**

- The **⚗ panel** jumps to any step, and lists every error and edge state the flow has (a wrong
  code, a failed search, an empty result). Pick one and it goes straight to that message and
  pauses there so you can read it; Play carries on from it. Errors Claude found but can't show
  from outside the flow are listed too, greyed, with the reason.
- **What if** switches the mock backend (slow, empty, failing), when the project has one.

**Comment, and Claude acts on it**

- Press **💬**, click anything on the page, and write what should change. The comment goes to
  Claude Code along with the step and the element it's about, and arrives in the conversation as
  you post it.
- Claude makes the change, replies and resolves it. A numbered pin marks each comment on the page;
  hover it for a preview, click it for the thread, and reply right there. Your replies go to
  Claude too. All comments are listed in the panel, open or resolved. Any other agent can read
  the same comments from a plain file.

**Review it**

- **Check this screen** flags buttons with no name, images with no alt text, fields with no
  label, low contrast, and words your style guide rules out.
- **Timing** shows how long each step takes at 1×.
- The **studio** (`/__prototype/studio`) shows the flow at any size: drag the frame's edges or
  corner, type a width and height, or pick a device. A device bigger than the window is scaled to
  fit. It **records** a play-through to MP4 and **screenshots every step and every error** in one go:
  sharp, at 2× pixel density, taken in a headless Chrome of its own, so the frame stays free.
- The **flow review** (`/__prototype/sheet`) goes through those screenshots one by one: steps and
  errors in a list, the screen large in the middle, and when it changed since the last tour, side
  by side, a before/after slider, or the changes marked. Beside it: what the checks found, its
  comments and how long the step takes. Filter to what changed or needs checking, tick screens off
  as you review them, or see them all in a grid.

**When a step breaks**, because you renamed a button say, the player shows what's on screen that
looks like it. Pick one and it carries on; Claude folds the fix into the script later.

## Why it's useful

- **Watch the flow as a user would.** Pacing problems, steps that drag and abrupt jumps show up
  when you watch, and they don't when you're clicking through quickly.
- **Get to any step at once.** Jump to the step you're changing instead of clicking from the start.
- **See every error state.** Each error message is one click away, so you can check its wording
  and design without working out how to trigger it.
- **Feedback straight to the code.** Point at the thing that's wrong and say so; Claude gets it
  with everything it needs to find the code, and tells you what it changed.
- **A review in one page.** Every screen of the flow and every error, at any device size, with
  what changed since last time.
- **Nothing to clean up.** The player never touches your flow's code, and git never sees it.
  Push your flow and the player stays on your machine.

## How it stays out of your code

Everything lives in a `.prototype/` folder at the repo root, listed in `.git/info/exclude`
(git's local-only ignore list, which is never committed). A small Vite config there loads your
project's own config and adds the player to the page, so you run a second dev server with the
player on top while your usual one carries on as normal. The player finds things by the text a
person reads, so the flow doesn't know it's there. Screenshots, recordings and comments are saved
in `.prototype/` too.

## Install

```bash
# Into a project (shared with everyone who clones it)
npx skills add sasura212/prototype-controls

# Just for you, in every project
git clone https://github.com/sasura212/prototype-controls ~/.claude/skills/prototype-controls
```

## Use

In Claude Code, with the flow built:

> /prototype-controls

That's all. Claude works out the flow's steps and every error state from the code, writes the
script, starts a dev server with the player on top, then plays the whole flow and opens every
error in a browser to check they work, fixing anything that doesn't. It starts watching for your
comments, and gives you the URL, the command to start it again, and a list of the errors it found,
including any it couldn't reach and why. Name the flow if you have more than one
(`/prototype-controls the checkout flow`).

To remove it, delete `.prototype/` and its line in `.git/info/exclude`.

## For other agents

Comments are in `.prototype/comments.jsonl`, one JSON event per line. `node .prototype/comment.mjs`
lists, shows, replies to, resolves and watches them; replies show on the comment's pin in the
browser. See the top of `templates/comment.mjs`.

## What's inside

| File                                    | What it is                                                              |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `SKILL.md`                              | The steps Claude follows                                                |
| `templates/overlay.ts` + `overlay.css`  | The player, the page's clock, and the ⚗ panel                           |
| `templates/comments.ts` + `comment.mjs` | Comments on the page, and their store and command line                  |
| `templates/checks.ts`                   | Check this screen                                                       |
| `templates/studio.*` + `sheet.*`        | The studio and the flow review                                          |
| `templates/tour.mjs`                    | The screenshot tour, in a headless Chrome of its own                    |
| `templates/vite.config.mjs`             | Adds the player to the page, and saves what it makes into `.prototype/` |
| `templates/check-wait.js`               | What Claude runs in the browser to check each step and error            |
| `templates/script.ts`                   | An example script                                                       |

Works with Vite projects. Previous replays from the start to the step before (in seconds), since
a page can't be wound back. Recording captures the tab with Chrome's screen-share prompt, once per
session; screenshots don't need it. Screenshot tours need Node 22+ and a Chrome or Edge installed
(or `CHROME_PATH`). Pause and speed cover timers, `Date.now` and animations, not `new Date()`.
