// Comments on the flow, left in the player: pick anything on the page, say what's wrong with it, and
// it goes to `.prototype/comments.jsonl` for Claude Code (or any agent) to act on. Pins mark them on
// the page; an agent's replies and resolutions (comment.mjs) show up on the pin, and you can answer.
import { selectorFor } from "./checks";
import { icon } from "./icons";

export type Comment = {
  id: string;
  text: string;
  by?: string;
  step?: string;
  path?: string | null;
  url: string;
  target?: { selector: string; text: string; html: string };
  viewport?: string;
  status: "open" | "resolved";
  replies: { by: string; text: string; at: string }[];
  resolvedNote?: string | null;
  at: string;
};
type Where = () => { step: string; path: string | null };
type Timers = { setTimeout: (fn: () => void, ms: number) => number };

const escape = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
/** "now", "4m", "2h", or the date: how long ago, the way comment threads say it. */
const ago = (at: string) => {
  const minutes = Math.round((Date.now() - new Date(at).getTime()) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};
const who = (by?: string) => (!by || by === "you" ? "You" : by);
const initial = (by?: string) => who(by).slice(0, 1).toUpperCase();

export const setUpComments = (root: ShadowRoot, host: HTMLElement, where: Where, real: Timers) => {
  const layer = document.createElement("div");
  layer.className = "comments";
  root.append(layer);
  const outline = document.createElement("div");
  outline.className = "pick";
  root.append(outline);
  const hint = document.createElement("div");
  hint.className = "pickHint";
  hint.textContent = "Click anything to comment on it · Esc to cancel";
  hint.hidden = true;
  root.append(hint);
  let comments: Comment[] = [];
  let picking = false;
  let openId: string | null = null;
  const listeners: ((open: number) => void)[] = [];

  const load = async () => {
    try {
      comments = await (await fetch("/__prototype/comments")).json();
    } catch {
      // No player server (the page opened on its own): no comments to show.
    }
    drawPins();
    const open = comments.filter((c) => c.status === "open").length;
    listeners.forEach((listener) => listener(open));
    // A thread that's open on screen picks up a new reply.
    if (openId) refreshThread();
  };
  const elementFor = (comment: Comment) => {
    if (!comment.target) return null;
    try {
      const el = document.querySelector(comment.target.selector);
      if (el) return el;
    } catch {
      // A selector the page no longer understands: fall back to the text.
    }
    const text = comment.target.text.toLowerCase();
    return text
      ? ([...document.querySelectorAll("body *")].find(
          (el) => (el as HTMLElement).innerText?.trim().toLowerCase() === text
        ) ?? null)
      : null;
  };
  const isHere = (comment: Comment) => {
    const here = where();
    return comment.url === location.pathname && (!comment.step || comment.step === here.step);
  };

  // Pins: the comments on this page and step, numbered teardrops at the element they're about.
  function drawPins() {
    layer.innerHTML = "";
    comments.forEach((comment, index) => {
      if (!isHere(comment)) return;
      const rect = elementFor(comment)?.getBoundingClientRect();
      if (!rect || !rect.width) return;
      const pin = document.createElement("button");
      pin.className = `pin ${comment.status}${comment.replies.length ? " answered" : ""}${comment.id === openId ? " active" : ""}`;
      pin.dataset.pin = comment.id;
      pin.innerHTML = `<span>${index + 1}</span><span class="peek">${escape(comment.text)}${
        comment.replies.length
          ? `<em>${comment.replies.length} ${comment.replies.length === 1 ? "reply" : "replies"}</em>`
          : ""
      }</span>`;
      pin.setAttribute("aria-label", `Comment ${index + 1}: ${comment.text}`);
      pin.style.left = `${Math.min(rect.right - 6, innerWidth - 30)}px`;
      pin.style.top = `${Math.max(rect.top - 26, 4)}px`;
      pin.addEventListener("click", () => openThread(comment.id));
      layer.append(pin);
    });
  }

  /** A card beside `near`: under it if there's room, else above. */
  const card = (html: string, near: DOMRect) => {
    root.querySelector(".thread")?.remove();
    const box = document.createElement("div");
    box.className = "thread";
    box.setAttribute("role", "dialog");
    box.innerHTML = html;
    box.style.left = `${Math.min(Math.max(near.left, 8), innerWidth - 336)}px`;
    root.append(box);
    const height = box.getBoundingClientRect().height;
    box.style.top = `${near.bottom + 10 + height > innerHeight - 8 ? Math.max(near.top - height - 10, 8) : near.bottom + 10}px`;
    return box;
  };
  const message = (by: string | undefined, text: string, at: string) =>
    `<div class="message"><span class="avatar ${by && by !== "you" ? "agent" : ""}">${initial(by)}</span>
      <span class="body"><span class="meta"><b>${escape(who(by))}</b> ${ago(at)}</span><span>${escape(text)}</span></span></div>`;

  const threadHtml = (comment: Comment) => {
    const number = comments.indexOf(comment) + 1;
    return `<header><b>Comment ${number}</b>${comment.status === "resolved" ? `<span class="tag">Resolved</span>` : ""}
        <span class="spacer"></span>
        <button data-c="toggle" class="icon" aria-label="${comment.status === "open" ? "Resolve" : "Reopen"}" title="${comment.status === "open" ? "Resolve" : "Reopen"}">${comment.status === "open" ? icon.check : icon.reopen}</button>
        <button data-c="close" class="icon" aria-label="Close">${icon.close}</button></header>
      <div class="messages">
        ${message(comment.by, comment.text, comment.at)}
        ${comment.replies.map((r) => message(r.by, r.text, r.at)).join("")}
        ${comment.status === "resolved" && comment.resolvedNote ? `<p class="note">Resolved: ${escape(comment.resolvedNote)}</p>` : ""}
      </div>
      <div class="compose"><textarea rows="1" placeholder="${comment.status === "open" ? "Reply…" : "Reopen and reply…"}"></textarea>
        <button data-c="reply" class="send" aria-label="Send">${icon.send}</button></div>`;
  };

  function openThread(id: string) {
    const comment = comments.find((c) => c.id === id);
    const pin = layer.querySelector<HTMLElement>(`[data-pin="${id}"]`);
    if (!comment) return;
    openId = id;
    const near = (pin ?? (elementFor(comment) as HTMLElement | null) ?? host).getBoundingClientRect();
    const box = card(threadHtml(comment), near);
    wireThread(box, comment);
    drawPins();
  }
  function refreshThread() {
    const box = root.querySelector<HTMLElement>(".thread[data-for]");
    const comment = comments.find((c) => c.id === openId);
    if (!box || !comment) return;
    const field = box.querySelector("textarea");
    // Leave it alone while a reply is being written.
    if (field && (field.value || root.activeElement === field)) return;
    box.innerHTML = threadHtml(comment);
    wireThread(box, comment);
  }
  function wireThread(box: HTMLElement, comment: Comment) {
    box.dataset.for = comment.id;
    const field = box.querySelector("textarea")!;
    const send = async () => {
      const text = field.value.trim();
      if (!text) return;
      if (comment.status === "resolved") await post({ type: "reopen", id: comment.id, by: "you" });
      await post({ type: "reply", id: comment.id, by: "you", text });
      field.value = "";
      refreshThread();
    };
    box.onclick = async (event) => {
      const action = (event.target as HTMLElement).closest<HTMLElement>("[data-c]")?.dataset.c;
      if (action === "toggle") {
        await post({ type: comment.status === "open" ? "resolve" : "reopen", id: comment.id, by: "you" });
        refreshThread();
      }
      if (action === "reply") void send();
      if (action === "close") closeThread();
    };
    field.onkeydown = (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void send();
      }
      if (event.key === "Escape") closeThread();
    };
    field.oninput = () => {
      field.style.height = "auto";
      field.style.height = `${Math.min(field.scrollHeight, 120)}px`;
    };
  }
  const closeThread = () => {
    openId = null;
    root.querySelector(".thread")?.remove();
    drawPins();
  };

  const post = async (event: Record<string, unknown>) => {
    await fetch("/__prototype/comments", { method: "POST", body: JSON.stringify(event) });
    await load();
  };

  // Picking: the element under the pointer is outlined; a click opens the box to write in.
  const hovered = (event: PointerEvent | MouseEvent) => {
    const el = document.elementFromPoint(event.clientX, event.clientY);
    return el && !host.contains(el) && el !== host ? el : null;
  };
  const onMove = (event: PointerEvent) => {
    const rect = hovered(event)?.getBoundingClientRect();
    outline.style.cssText = rect
      ? `display:block;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`
      : "display:none";
  };
  const onPick = (event: MouseEvent) => {
    if (event.composedPath().includes(host)) return;
    const el = hovered(event);
    event.preventDefault();
    event.stopPropagation();
    stopPicking();
    if (el) write(el);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") stopPicking();
  };
  const stopPicking = () => {
    picking = false;
    outline.style.display = "none";
    hint.hidden = true;
    document.removeEventListener("pointermove", onMove, true);
    document.removeEventListener("click", onPick, true);
    document.removeEventListener("keydown", onKey, true);
    document.documentElement.style.cursor = "";
  };
  const startPicking = () => {
    if (picking) return stopPicking();
    closeThread();
    picking = true;
    hint.hidden = false;
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("click", onPick, true);
    document.addEventListener("keydown", onKey, true);
    document.documentElement.style.cursor = "crosshair";
  };

  const write = (el: Element) => {
    const text = ((el as HTMLElement).innerText ?? "").trim().slice(0, 120);
    const box = card(
      `<header><b>New comment</b><span class="spacer"></span><button data-c="cancel" class="icon" aria-label="Cancel">${icon.close}</button></header>
       <p class="about">On ${text ? `“${escape(text.slice(0, 70))}”` : `this ${el.tagName.toLowerCase()}`}</p>
       <div class="compose"><textarea rows="2" placeholder="What should change? Claude gets it with this element."></textarea>
         <button data-c="send" class="send" aria-label="Post">${icon.send}</button></div>
       <p class="hint">Enter to post · Shift+Enter for a new line</p>`,
      el.getBoundingClientRect()
    );
    const field = box.querySelector("textarea")!;
    real.setTimeout(() => field.focus(), 0);
    const send = async () => {
      if (!field.value.trim()) return;
      const here = where();
      await post({
        type: "comment",
        by: "you",
        text: field.value.trim(),
        step: here.step,
        path: here.path,
        url: location.pathname,
        target: { selector: selectorFor(el), text, html: el.outerHTML.slice(0, 600) },
        viewport: `${innerWidth}×${innerHeight}`,
      });
      box.remove();
    };
    box.onclick = (event) => {
      const action = (event.target as HTMLElement).closest<HTMLElement>("[data-c]")?.dataset.c;
      if (action === "send") void send();
      if (action === "cancel") box.remove();
    };
    field.onkeydown = (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void send();
      }
      if (event.key === "Escape") box.remove();
    };
  };

  // Replies and resolutions arrive from the agent: look every few seconds; pins follow the page.
  real.setTimeout(function poll() {
    void load();
    real.setTimeout(poll, 3000);
  }, 0);
  addEventListener("scroll", drawPins, true);
  addEventListener("resize", drawPins);

  return {
    startPicking,
    redraw: drawPins,
    open: openThread,
    all: () => comments,
    onChange: (listener: (open: number) => void) => listeners.push(listener),
  };
};
