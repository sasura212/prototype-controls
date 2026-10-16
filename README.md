# prototype-controls

A Claude Code skill that puts a video-style player on top of a flow you're building, so you can
watch it work.

Run `/prototype-controls` on a flow and Claude adds a dark player bar to the page:

- **Play** runs the flow by itself, step by step, at a person's pace: it types into the real
  fields and clicks the real buttons. Long waits (a search that takes minutes) go by fast.
- **Pause** freezes the page like a paused video: timers, animations, everything.
- **Previous / next** move a step. **Replay** starts over.
- The **⚗ panel** jumps to any step, or plays an error path (a wrong code, a failed search) from
  where it happens.

## Why it's useful

- **Watch the flow as a user would.** Pacing problems, steps that drag and abrupt jumps show up
  when you watch, and they don't when you're clicking through quickly.
- **Get to any step at once.** Jump to the step you're changing instead of clicking from the start.
- **Test every edge case.** Each error path is one click away.
- **Nothing to clean up.** The player never touches your flow's code, and git never sees it.
  Push your flow and the player stays on your machine.

## How it stays out of your code

Everything lives in a `.prototype/` folder at the repo root, listed in `.git/info/exclude`
(git's local-only ignore list, which is never committed). A small Vite config there loads your
project's own config and adds the player to the page, so you run a second dev server with the
player on top while your usual one carries on as normal. The player finds things by the text a
person reads, so the flow doesn't know it's there.

## Install

```bash
# Into a project (shared with everyone who clones it)
npx skills add <owner>/<repo>

# Just for you, in every project
cp -r prototype-controls ~/.claude/skills/
```

## Use

In Claude Code, with the flow built:

> /prototype-controls on the onboarding flow

Claude reads the flow, writes the script for it, starts the player's dev server and plays it once
to check it works. It then gives you the URL and the command to start it again.

To remove it, delete `.prototype/` and its line in `.git/info/exclude`.

## What's inside

| File                                   | What it is                                                 |
| -------------------------------------- | ---------------------------------------------------------- |
| `SKILL.md`                             | The steps Claude follows                                   |
| `templates/overlay.ts` + `overlay.css` | The player, and what drives the page                       |
| `templates/script.ts`                  | An example script: chapters, a reset, an error path        |
| `templates/vite.config.mjs`            | Adds the player to the page on top of your own Vite config |

Works with Vite projects. Previous replays from the start to the step before (in seconds), since
a page can't be wound back. Pause and fast-forward cover timers and `Date.now`, not `new Date()`.
