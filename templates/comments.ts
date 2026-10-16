// Comments on the flow, left in the player: pick anything on the page, say what's wrong with it, and
// it goes to `.prototype/comments.jsonl` for Claude Code (or any agent) to act on. Pins mark them on
// the page; an agent's replies and resolutions (comment.mjs) show up on the pin.
import { selectorFor } from "./checks";

export type Comment = {
  id: string;
  text: string;
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

export const setUpComments = (root: ShadowRoot, host: HTMLElement, where: Where, real: Timers) => {
  const layer = document.createElement("div");
  layer.className = "comments";
  root.append(layer);
  const outline = document.createElement("div");
  outline.className = "pick";
  root.append(outline);
  let comments: Comment[] = [];
  let picking = false;
  let onChange: (open: number) => void = () => {};

  const load = async () => {
    try {
      comments = await (await fetch("/__prototype/comments")).json();
    } catch {
      // No player server (the page opened on its own): no comments to show.
    }
    drawPins();
    onChange(comments.filter((c) => c.status === "open").length);
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

  // Pins: the comments on this page and step, numbered, at the element they're about.
  function drawPins() {
    const here = where();
    layer.innerHTML = "";
    comments.forEach((comment, index) => {
      if (comment.url !== location.pathname || (comment.step && comment.step !== here.step)) return;
      const el = elementFor(comment);
      const rect = el?.getBoundingClientRect();
      if (!rect || !rect.width) return;
      const pin = document.createElement("button");
      pin.className = `pin ${comment.status}${comment.replies.length ? " answered" : ""}`;
      pin.textContent = String(index + 1);
      pin.setAttribute("aria-label", `Comment ${index + 1}: ${comment.text}`);
      pin.style.left = `${Math.min(rect.right - 10, innerWidth - 28)}px`;
      pin.style.top = `${Math.max(rect.top - 10, 4)}px`;
      pin.addEventListener("click", () => openThread(comment, pin));
      layer.append(pin);
    });
  }

  const card = (html: string, near: DOMRect) => {
    root.querySelector(".thread")?.remove();
    const box = document.createElement("div");
    box.className = "thread";
    box.innerHTML = html;
    box.style.left = `${Math.min(Math.max(near.left, 8), innerWidth - 328)}px`;
    box.style.top = `${near.bottom + 8 > innerHeight - 220 ? Math.max(near.top - 228, 8) : near.bottom + 8}px`;
    root.append(box);
    return box;
  };

  const openThread = (comment: Comment, pin: HTMLElement) => {
    const box = card(
      `<p class="said">${escape(comment.text)}</p>
       ${comment.replies.map((r) => `<p class="reply"><b>${escape(r.by)}</b> ${escape(r.text)}</p>`).join("")}
       ${comment.status === "resolved" ? `<p class="resolved">Resolved${comment.resolvedNote ? `: ${escape(comment.resolvedNote)}` : ""}</p>` : ""}
       <span class="row">
         <button data-c="close">Close</button>
         <button data-c="toggle">${comment.status === "open" ? "Resolve" : "Reopen"}</button>
       </span>`,
      pin.getBoundingClientRect()
    );
    box.addEventListener("click", async (event) => {
      const action = (event.target as HTMLElement).dataset.c;
      if (action === "toggle")
        await post({ type: comment.status === "open" ? "resolve" : "reopen", id: comment.id, by: "you" });
      if (action) box.remove();
    });
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
    document.removeEventListener("pointermove", onMove, true);
    document.removeEventListener("click", onPick, true);
    document.removeEventListener("keydown", onKey, true);
    document.documentElement.style.cursor = "";
  };
  const startPicking = () => {
    if (picking) return stopPicking();
    picking = true;
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("click", onPick, true);
    document.addEventListener("keydown", onKey, true);
    document.documentElement.style.cursor = "crosshair";
  };

  const write = (el: Element) => {
    const text = ((el as HTMLElement).innerText ?? "").trim().slice(0, 120);
    const box = card(
      `<p class="about">On ${text ? `“${escape(text.slice(0, 60))}”` : `a ${el.tagName.toLowerCase()}`}</p>
       <textarea rows="3" placeholder="What should change? It goes to Claude Code."></textarea>
       <span class="row"><button data-c="cancel">Cancel</button><button data-c="send" class="send">Send</button></span>`,
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
    box.addEventListener("click", (event) => {
      const action = (event.target as HTMLElement).dataset.c;
      if (action === "send") void send();
      if (action === "cancel") box.remove();
    });
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send();
      if (event.key === "Escape") box.remove();
    });
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
    all: () => comments,
    onChange: (listener: (open: number) => void) => (onChange = listener),
  };
};
