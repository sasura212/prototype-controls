#!/usr/bin/env node
// Comments left on the flow in the prototype player, for Claude Code or any other agent to act on.
// Local only, like the rest of `.prototype/`. They live in `.prototype/comments.jsonl`: one event
// per line, appended, so anything can tail it.
//
// New comments start as drafts: the person piles them up while going through the flow, then sends
// them in one go. The agent gets the batch as one list and works through it.
//
//   node .prototype/comment.mjs list            every sent comment, open ones first
//   node .prototype/comment.mjs list --open     only the open ones (the work to do)
//   node .prototype/comment.mjs show <id>       one comment in full: where it is, the element, the thread
//   node .prototype/comment.mjs reply <id> "…"  answer it; the reply shows on its pin in the browser
//   node .prototype/comment.mjs resolve <id> ["what changed"]
//   node .prototype/comment.mjs reopen <id>
//   node .prototype/comment.mjs watch           print each batch sent, and each reply from the person
//
// `watch` is for an agent to follow along live (Claude Code: run it under the Monitor tool), so a
// batch sent from the browser arrives in the conversation and gets worked on.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "comments.jsonl");

/** Every event in the file. A line that doesn't parse (half-written, damaged) is skipped, not the whole file. */
export const readEvents = () => {
  let text;
  try {
    text = fs.readFileSync(FILE, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((line) => {
    try {
      return line ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
};

export const append = (event) => {
  const full = { ...event, at: event.at ?? new Date().toISOString() };
  fs.appendFileSync(FILE, `${JSON.stringify(full)}\n`);
  return full;
};

/**
 * The events folded into comments: each with its replies and its status. "draft" until sent, then
 * "open" until resolved. Deleted drafts are gone.
 */
export const fold = (events) => {
  const comments = new Map();
  for (const event of events) {
    if (event.type === "comment")
      comments.set(event.id, { ...event, status: event.draft ? "draft" : "open", replies: [] });
    if (event.type === "send")
      for (const id of event.ids ?? []) {
        const comment = comments.get(id);
        if (comment?.status === "draft")
          Object.assign(comment, { status: "open", sentAt: event.at, batch: event.batch });
      }
    const comment = comments.get(event.id);
    if (!comment || event.type === "comment") continue;
    if (event.type === "edit") comment.text = event.text;
    if (event.type === "delete") comments.delete(event.id);
    if (event.type === "reply") comment.replies.push({ by: event.by, text: event.text, at: event.at });
    if (event.type === "resolve") Object.assign(comment, { status: "resolved", resolvedNote: event.note ?? null });
    if (event.type === "reopen") comment.status = "open";
  }
  return [...comments.values()];
};

/** The next id: one past the highest ever used, so a deleted comment's id is never handed out again. */
export const nextId = (events) =>
  `c${Math.max(0, ...events.filter((e) => e.type === "comment").map((e) => Number(String(e.id).slice(1)) || 0)) + 1}`;

const where = (c) =>
  `${c.step ?? ""}${c.path ? ` (${c.path})` : ""}: “${c.text}” on ${c.target?.text ? `“${c.target.text.replace(/\s+/g, " ").slice(0, 80)}”` : (c.target?.selector ?? "the page")}`;
const oneLine = (c) => `${c.id} [${c.status}] ${where(c)}`;

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
    const order = { open: 0, resolved: 1 };
    const all = fold(readEvents())
      .filter((c) => c.status !== "draft")
      .sort((a, b) => order[a.status] - order[b.status]);
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
    // New events only: everything already in the file has been seen.
    let seen = readEvents().length;
    if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, "");
    let size = fs.statSync(FILE).size;
    const check = () => {
      const events = readEvents();
      // Only a file that got smaller was rewritten (cleared, trimmed): what's in it now isn't news.
      const now = fs.existsSync(FILE) ? fs.statSync(FILE).size : 0;
      if (now < size) seen = events.length;
      size = now;
      for (const event of events.slice(seen)) {
        // A batch sent: one message with every comment in it, so the agent sees the whole list at once.
        if (event.type === "send") {
          const sent = fold(events).filter((c) => event.ids?.includes(c.id));
          console.log(
            [
              `Batch of ${sent.length} ${sent.length === 1 ? "comment" : "comments"} sent:`,
              ...sent.map((c) => `  ${c.id} ${where(c)}`),
            ].join("\n")
          );
        }
        // A comment sent straight away (not as a draft) comes on its own.
        if (event.type === "comment" && !event.draft) console.log(oneLine({ ...event, status: "open" }));
        // Their answer on a thread is for the agent too; the agent's own replies aren't news to it.
        if (event.type === "reply" && event.by === "you") console.log(`${event.id} reply from you: “${event.text}”`);
      }
      seen = Math.max(seen, events.length);
    };
    // A file watch plus a timer: the watch can miss a write that lands as it starts.
    fs.watchFile(FILE, { interval: 500 }, check);
    setInterval(check, 1000);
    console.error(`Watching ${FILE} for comments.`);
  } else {
    console.error(
      "Commands: list [--open] | show <id> | reply <id> <text> | resolve <id> [note] | reopen <id> | watch"
    );
    process.exit(1);
  }
}
