#!/usr/bin/env node
// Comments left on the flow in the prototype player, for Claude Code or any other agent to act on.
// Local only, like the rest of `.prototype/`. They live in `.prototype/comments.jsonl`: one event
// per line, appended, so anything can tail it.
//
//   node .prototype/comment.mjs list            every comment, open ones first
//   node .prototype/comment.mjs list --open     only the open ones
//   node .prototype/comment.mjs show <id>       one comment in full: where it is, the element, the thread
//   node .prototype/comment.mjs reply <id> "…"  answer it; the reply shows on its pin in the browser
//   node .prototype/comment.mjs resolve <id> ["what changed"]
//   node .prototype/comment.mjs reopen <id>
//   node .prototype/comment.mjs watch           print each new comment as one line, as it's posted
//
// `watch` is for an agent to follow along live (Claude Code: run it under the Monitor tool), so a
// comment written in the browser arrives in the conversation and gets worked on.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "comments.jsonl");

export const readEvents = () => {
  try {
    return fs
      .readFileSync(FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

export const append = (event) => {
  const full = { ...event, at: event.at ?? new Date().toISOString() };
  fs.appendFileSync(FILE, `${JSON.stringify(full)}\n`);
  return full;
};

/** The events folded into comments: each with its replies and whether it's open. */
export const fold = (events) => {
  const comments = new Map();
  for (const event of events) {
    if (event.type === "comment") comments.set(event.id, { ...event, status: "open", replies: [] });
    const comment = comments.get(event.id);
    if (!comment || event.type === "comment") continue;
    if (event.type === "reply") comment.replies.push({ by: event.by, text: event.text, at: event.at });
    if (event.type === "resolve") Object.assign(comment, { status: "resolved", resolvedNote: event.note ?? null });
    if (event.type === "reopen") comment.status = "open";
  }
  return [...comments.values()];
};

export const nextId = (events) => `c${events.filter((event) => event.type === "comment").length + 1}`;

const oneLine = (c) =>
  `${c.id} [${c.status}] ${c.step ?? ""}${c.path ? ` (${c.path})` : ""}: “${c.text}” on ${c.target?.text ? `“${c.target.text}”` : (c.target?.selector ?? "the page")}`;

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [command, id, ...rest] = process.argv.slice(2);
  const by = process.env.COMMENT_BY ?? "agent";
  const find = () => {
    const comment = fold(readEvents()).find((c) => c.id === id);
    if (!comment) {
      console.error(`No comment ${id}`);
      process.exit(1);
    }
    return comment;
  };
  if (command === "list" || !command) {
    const all = fold(readEvents()).sort((a, b) => (a.status === b.status ? 0 : a.status === "open" ? -1 : 1));
    const shown = id === "--open" ? all.filter((c) => c.status === "open") : all;
    console.log(shown.length ? shown.map(oneLine).join("\n") : "No comments.");
  } else if (command === "show") {
    console.log(JSON.stringify(find(), null, 2));
  } else if (command === "reply") {
    find();
    append({ type: "reply", id, by, text: rest.join(" ") });
    console.log(`Replied to ${id}.`);
  } else if (command === "resolve") {
    find();
    append({ type: "resolve", id, by, note: rest.join(" ") || null });
    console.log(`Resolved ${id}.`);
  } else if (command === "reopen") {
    find();
    append({ type: "reopen", id, by });
    console.log(`Reopened ${id}.`);
  } else if (command === "watch") {
    // New comments only: everything already in the file has been seen.
    let seen = readEvents().length;
    if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, "");
    const check = () => {
      const events = readEvents();
      if (events.length < seen) seen = events.length;
      for (const event of events.slice(seen))
        if (event.type === "comment") console.log(oneLine({ ...event, status: "open" }));
      seen = events.length;
    };
    // A file watch plus a timer: the watch can miss a write that lands as it starts.
    fs.watchFile(FILE, { interval: 500 }, check);
    setInterval(check, 1000);
    console.error(`Watching ${FILE} for new comments.`);
  } else {
    console.error(
      "Commands: list [--open] | show <id> | reply <id> <text> | resolve <id> [note] | reopen <id> | watch"
    );
    process.exit(1);
  }
}
