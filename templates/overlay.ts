// Prototype player, on top of a flow. Local only: `.prototype/` is listed in .git/info/exclude and
// added to the page by .prototype/vite.config.mjs, so nothing here is committed or pushed.
//
// It plays `script.ts` by driving the real page: it waits for what a person would see, then clicks
// and types the way they would. It also holds the page's clock, so pause freezes the page (its
// timers, animations and Date.now) like a paused video, and skipping runs that clock fast.
import script from "./script";
import css from "./overlay.css?inline";

export type Target = string | { css: string };
export type Page = {
  /** Wait a beat, then click the button, link, tab or option with this text (or label), once it's there. */
  click: (target: Target) => Promise<void>;
  /** Wait a beat, then type into the field with this placeholder, label or aria-label. */
  type: (target: Target, text: string) => Promise<void>;
  /** Press a key in the focused field (Enter, Escape, Tab, ArrowDown…). */
  press: (key: string) => Promise<void>;
  /** Wait until this text (or a `{ css }` element) is on the page, in real time. */
  waitFor: (target: Target, timeoutMs?: number) => Promise<void>;
  /** Wait until it's there with the page's clock running fast: for waits a viewer shouldn't sit through. */
  skipUntil: (target: Target, timeoutMs?: number) => Promise<void>;
  /** Wait this long; skipped when moving ahead. */
  wait: (ms: number) => Promise<void>;
  /** Open a URL in the app (client-side). */
  goto: (url: string) => Promise<void>;
  /** True while moving ahead to a later chapter: no beats, the clock running fast. */
  isSkipping: () => boolean;
};
export type Placement = "left" | "centre" | "right";
export type Chapter = {
  title: string;
  run: (page: Page) => Promise<void>;
  /** Where the bar sits during this chapter, when the page has something there (default: `script.placement`). */
  placement?: Placement;
};
export type Path = {
  id: string;
  label: string;
  /** Where this path starts, if not `script.start` (e.g. a URL that opens a scenario). */
  start?: string;
  /** Before it loads: set a mock backend's scenario, seed storage. */
  setup?: () => Promise<void> | void;
  /** Chapters that play differently on this path, by title. */
  chapters: Record<string, Chapter["run"]>;
};
export type Script = {
  /** Where the flow starts: replay and going back reload this. */
  start: string;
  /** Before every reload: clear the flow's saved state (and sign out, if need be) so it starts clean. */
  reset?: () => Promise<void> | void;
  chapters: Chapter[];
  paths?: Path[];
  /** How long a person takes before each click or field (default 1800). */
  beatMs?: number;
  placement?: Placement;
};

// ------------------------------------------------------------------------------------------------
// The page's clock. Installed before the app runs (the script is the first thing in <head>), so
// every timer the app sets goes through it. The player itself keeps the real ones.
// ------------------------------------------------------------------------------------------------
const real = {
  setTimeout: window.setTimeout.bind(window),
  clearTimeout: window.clearTimeout.bind(window),
  raf: window.requestAnimationFrame.bind(window),
  now: Date.now.bind(Date),
};
/** How fast the page's clock runs while skipping. */
const FAST = 40;

const clock = (() => {
  let speed = 1;
  let realAt = real.now();
  let pageAt = realAt;
  type Timer = {
    id: number;
    due: number;
    every: number | null;
    fn: TimerHandler;
    args: unknown[];
    handle?: number;
  };
  const timers = new Map<number, Timer>();
  let nextId = 1_000_000_000;
  let held: FrameRequestCallback[] = [];
  let pausedAnimations: Animation[] = [];

  const now = () => pageAt + (real.now() - realAt) * speed;
  const arm = (timer: Timer) => {
    if (timer.handle !== undefined) real.clearTimeout(timer.handle);
    timer.handle =
      speed === 0 ? undefined : real.setTimeout(() => fire(timer), Math.max(0, (timer.due - now()) / speed));
  };
  const fire = (timer: Timer) => {
    if (!timers.has(timer.id)) return;
    if (timer.every === null) timers.delete(timer.id);
    else {
      timer.due += timer.every;
      arm(timer);
    }
    if (typeof timer.fn === "function") timer.fn(...timer.args);
  };
  const add = (fn: TimerHandler, ms: unknown, args: unknown[], repeat: boolean) => {
    const delay = Math.max(0, Number(ms) || 0);
    const timer: Timer = {
      id: nextId++,
      due: now() + delay,
      every: repeat ? Math.max(delay, 4) : null,
      fn,
      args,
    };
    timers.set(timer.id, timer);
    arm(timer);
    return timer.id;
  };
  const clear = (id?: unknown) => {
    const timer = typeof id === "number" ? timers.get(id) : undefined;
    // SAFETY: an id the player didn't make came from the real timers, made before it was installed.
    if (!timer) return real.clearTimeout(id as number | undefined);
    if (timer.handle !== undefined) real.clearTimeout(timer.handle);
    timers.delete(timer.id);
  };

  // SAFETY: the same signatures as the globals they replace; the ids are numbers either way.
  window.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) =>
    add(fn, ms, args, false)) as typeof window.setTimeout;
  window.setInterval = ((fn: TimerHandler, ms?: number, ...args: unknown[]) =>
    add(fn, ms, args, true)) as typeof window.setInterval;
  window.clearTimeout = clear as typeof window.clearTimeout;
  window.clearInterval = clear as typeof window.clearInterval;
  Date.now = () => Math.round(now());
  window.requestAnimationFrame = (callback) => {
    if (speed !== 0) return real.raf(callback);
    held.push(callback);
    return 0;
  };

  return {
    set(next: number) {
      if (next === speed) return;
      pageAt = now();
      realAt = real.now();
      const wasStill = speed === 0;
      speed = next;
      timers.forEach(arm);
      // Frozen means frozen: CSS animations and transitions hold too, and pick up where they were.
      if (next === 0) {
        pausedAnimations = document.getAnimations().filter((animation) => animation.playState === "running");
        pausedAnimations.forEach((animation) => animation.pause());
      } else if (wasStill) {
        pausedAnimations.forEach((animation) => animation.play());
        pausedAnimations = [];
        const callbacks = held;
        held = [];
        callbacks.forEach((callback) => real.raf(callback));
      }
    },
  };
})();

// ------------------------------------------------------------------------------------------------
// State, kept for the tab so a reload (replay, going back) carries on.
// ------------------------------------------------------------------------------------------------
type Saved = {
  chapter: number;
  /** Moving ahead to this chapter (after a reload, for going back). */
  target: number | null;
  playing: boolean;
  /** Paused by the viewer: the page is frozen. */
  frozen: boolean;
  path: string | null;
};
const KEY = "prototype-overlay";
const FIND_MS = 20_000;
const beat = script.beatMs ?? 1800;
const fresh: Saved = {
  chapter: 0,
  target: null,
  playing: false,
  frozen: false,
  path: null,
};

const load = (): Saved => {
  try {
    return { ...fresh, ...JSON.parse(sessionStorage.getItem(KEY) ?? "{}") };
  } catch {
    return fresh;
  }
};
let state = load();
/**
 * The page reloaded while playing (a dev-server reload, an edit to the script): the flow is back at
 * its start, so replay up to the chapter it was on. The flow's own page loads carry on as they are.
 */
const isReload =
  (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type === "reload";
const interruptedAt = state.target === null && state.playing && isReload ? state.chapter : null;
// Otherwise a load that wasn't headed anywhere and isn't mid-play is a fresh visit: start at the top.
if (state.target === null && !state.playing) state = { ...fresh };
let stuck: string | null = null;
let done = false;
let skipWaits = 0;
let running = false;
let generation = 0;
let wake: (() => void) | null = null;

const isSkipping = () => state.target !== null && state.chapter < state.target;
const path = () => script.paths?.find((item) => item.id === state.path) ?? null;
const syncClock = () => clock.set(state.frozen ? 0 : isSkipping() || skipWaits > 0 ? FAST : 1);
const save = () => {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage blocked: the player still works until the page reloads.
  }
};
const set = (next: Partial<Saved>) => {
  state = { ...state, ...next };
  save();
  syncClock();
  render();
  wake?.();
};

class Stop extends Error {}
const realSleep = (ms: number) => new Promise<void>((resolve) => real.setTimeout(resolve, ms));

/** Holds while paused; returns at once while playing or moving ahead. */
const gate = async (mine: number) => {
  while (!state.playing && !isSkipping()) {
    await new Promise<void>((resolve) => (wake = resolve));
    if (mine !== generation) throw new Stop();
  }
  if (mine !== generation) throw new Stop();
};
/** A beat or a wait, in real time: cut short by moving ahead, held while paused. */
const sleep = async (ms: number, mine: number) => {
  let left = ms;
  while (left > 0) {
    if (mine !== generation) throw new Stop();
    if (isSkipping()) return;
    await realSleep(50);
    if (state.playing) left -= 50;
  }
};

// ------------------------------------------------------------------------------------------------
// Finding things the way a person does: by what they read.
// ------------------------------------------------------------------------------------------------
const norm = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const isShown = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
const CLICKABLE =
  "button, a, [role=button], [role=tab], [role=option], [role=menuitem], [role=checkbox], [role=switch], [role=radio], label, summary";
const FIELDS = "input:not([type=hidden]), textarea, [contenteditable=true]";

const pick = <T extends Element>(all: T[], names: (el: T) => string[], want: string) =>
  all.find((el) => names(el).some((name) => norm(name) === want)) ??
  all.find((el) => names(el).some((name) => norm(name).includes(want)));
const findClickable = (target: Target) => {
  if (typeof target !== "string") return document.querySelector<HTMLElement>(target.css);
  const all = [...document.querySelectorAll<HTMLElement>(CLICKABLE)].filter(isShown);
  return pick(all, (el) => [el.innerText, el.getAttribute("aria-label") ?? "", el.title], norm(target)) ?? null;
};
const findField = (target: Target) => {
  if (typeof target !== "string") return document.querySelector<HTMLElement>(target.css);
  const all = [...document.querySelectorAll<HTMLElement>(FIELDS)].filter(isShown);
  const labelOf = (el: HTMLElement) =>
    [...((el as HTMLInputElement).labels ?? [])].map((label) => label.innerText).join(" ");
  const names = (el: HTMLElement) => [
    el.getAttribute("placeholder") ?? "",
    el.getAttribute("aria-label") ?? "",
    el.getAttribute("name") ?? "",
    labelOf(el),
  ];
  return pick(all, names, norm(target)) ?? null;
};
const describe = (target: Target) => (typeof target === "string" ? `“${target}”` : target.css);

/** Polls until `find` returns something, saying what it waits on once it's been a while. */
const until = async <T>(find: () => T | null | undefined, what: string, mine: number, timeoutMs = FIND_MS) => {
  const started = real.now();
  for (;;) {
    if (mine !== generation) throw new Stop();
    const found = find();
    if (found) {
      if (stuck) {
        stuck = null;
        render();
      }
      return found;
    }
    if (real.now() - started > timeoutMs && !stuck) {
      stuck = `Waiting for ${what}`;
      render();
    }
    await realSleep(100);
  }
};

const setValue = (el: HTMLElement, value: string) => {
  if (el.isContentEditable) el.textContent = value;
  else {
    // React tracks the value itself: set it through the native setter so the change is seen.
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
};

const pageFor = (mine: number): Page => {
  const beforeAct = async () => {
    await gate(mine);
    await sleep(beat, mine);
    await gate(mine);
  };
  const waitFor = (target: Target, timeoutMs?: number) =>
    until(
      () =>
        typeof target === "string"
          ? norm(document.body.innerText).includes(norm(target))
          : document.querySelector(target.css),
      describe(target),
      mine,
      timeoutMs
    ).then(() => undefined);
  return {
    isSkipping,
    async click(target) {
      await beforeAct();
      const el = await until(
        () => {
          const found = findClickable(target);
          const isOff =
            (found as HTMLButtonElement | null)?.disabled || found?.getAttribute("aria-disabled") === "true";
          return found && !isOff ? found : null;
        },
        describe(target),
        mine
      );
      await gate(mine);
      el.scrollIntoView({ block: "nearest" });
      ringAt(el);
      await sleep(250, mine);
      el.click();
    },
    async type(target, text) {
      await beforeAct();
      const el = await until(() => findField(target), describe(target), mine);
      el.scrollIntoView({ block: "nearest" });
      el.focus();
      if (isSkipping()) setValue(el, text);
      else
        for (let i = 1; i <= text.length; i++) {
          await gate(mine);
          setValue(el, text.slice(0, i));
          await sleep(35, mine);
        }
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    async press(key) {
      await gate(mine);
      const el = (document.activeElement as HTMLElement | null) ?? document.body;
      for (const type of ["keydown", "keyup"]) el.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true }));
      if (key === "Enter" && el instanceof HTMLInputElement) el.form?.requestSubmit();
    },
    waitFor,
    async skipUntil(target, timeoutMs) {
      skipWaits++;
      syncClock();
      try {
        await waitFor(target, timeoutMs);
      } finally {
        skipWaits--;
        syncClock();
      }
    },
    async wait(ms) {
      await gate(mine);
      await sleep(ms, mine);
    },
    async goto(url) {
      await gate(mine);
      history.pushState(null, "", url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
  };
};

// ------------------------------------------------------------------------------------------------
// Playing.
// ------------------------------------------------------------------------------------------------
const run = async () => {
  if (running) return;
  running = true;
  done = false;
  const mine = generation;
  try {
    while (state.chapter < script.chapters.length) {
      const chapter = script.chapters[state.chapter];
      await gate(mine);
      await (path()?.chapters[chapter.title] ?? chapter.run)(pageFor(mine));
      if (mine !== generation) return;
      const next = state.chapter + 1;
      if (next >= script.chapters.length) break;
      const arrived = state.target !== null && next >= state.target;
      // Arriving where it was headed: carry on if it was playing, else hold there, frozen.
      set({
        chapter: next,
        target: arrived ? null : state.target,
        frozen: arrived && !state.playing,
      });
    }
    done = true;
    set({ playing: false });
  } catch (error) {
    if (!(error instanceof Stop)) {
      stuck = `Stopped: ${error instanceof Error ? error.message : String(error)}`;
      set({ playing: false });
    }
  } finally {
    if (mine === generation) running = false;
  }
};

/** Starts over from the flow's first page and moves ahead to `target`, as fast as the page allows. */
const restart = async (next: Partial<Saved>) => {
  generation++;
  // Headed for chapter 1 at least, so the reload knows it's a replay, not a fresh visit.
  set({ chapter: 0, target: 0, frozen: false, ...next });
  await script.reset?.();
  await path()?.setup?.();
  window.location.assign(path()?.start ?? script.start);
};
const goTo = (index: number) => {
  const to = Math.max(0, Math.min(index, script.chapters.length - 1));
  if (to === state.chapter) return;
  // Ahead: finish what's on screen fast and carry on. Back: the page can't be wound back, so it
  // replays from the start up to there, with the clock running fast, in a few seconds.
  if (to > state.chapter) {
    set({ target: to, frozen: false });
    void run();
  } else void restart({ target: to, playing: state.playing });
};

// ------------------------------------------------------------------------------------------------
// The bar.
// ------------------------------------------------------------------------------------------------
const host = document.createElement("div");
host.setAttribute("data-prototype-overlay", "");
const root = host.attachShadow({ mode: "open" });
root.innerHTML = `<style>${css}</style>
<div class="ring"></div>
<section class="player" aria-label="Prototype player">
  <span class="buttons">
    <button data-do="prev" aria-label="Previous step">⏮</button>
    <button data-do="play" class="play" aria-label="Play">▶</button>
    <button data-do="next" aria-label="Next step">⏭</button>
  </span>
  <span class="now">
    <span class="label" aria-live="polite"></span>
    <span class="note"></span>
    <span class="bar"></span>
  </span>
  <button data-do="replay" aria-label="Replay from the start">↺</button>
  <button data-do="controls" aria-label="Prototype controls" aria-expanded="false">⚗</button>
  <div class="controls" hidden>
    <label>Jump to <select data-do="jump"></select></label>
    <label>Play a path <select data-do="path"></select></label>
  </div>
</section>`;
const $ = <T extends Element>(selector: string) => root.querySelector<T>(selector)!;
const ring = $<HTMLDivElement>(".ring");
const jumpSelect = $<HTMLSelectElement>("[data-do=jump]");
const pathSelect = $<HTMLSelectElement>("[data-do=path]");
jumpSelect.innerHTML = script.chapters.map((c, i) => `<option value="${i}">${i + 1} · ${c.title}</option>`).join("");
pathSelect.innerHTML = [
  `<option value="">None</option>`,
  ...(script.paths ?? []).map((p) => `<option value="${p.id}">${p.label}</option>`),
].join("");
$<HTMLElement>(".bar").innerHTML = script.chapters.map(() => "<span></span>").join("");

/** A ring where the click lands, so a watcher sees what was pressed. */
function ringAt(el: Element) {
  const rect = el.getBoundingClientRect();
  ring.style.cssText = `display:block;left:${rect.left - 4}px;top:${rect.top - 4}px;width:${rect.width + 8}px;height:${rect.height + 8}px`;
  real.setTimeout(() => (ring.style.display = "none"), 450);
}

function render() {
  const count = script.chapters.length;
  const chapter = script.chapters[state.chapter];
  $<HTMLElement>(".player").className = `player ${chapter?.placement ?? script.placement ?? "left"}`;
  $<HTMLElement>(".label").textContent = `${state.chapter + 1} of ${count} · ${chapter?.title ?? ""}`;
  const skippingTo = isSkipping() ? script.chapters[state.target ?? 0]?.title : null;
  const note = skippingTo
    ? `Skipping to ${skippingTo}…`
    : state.frozen
      ? "Paused"
      : (stuck ?? (path() ? `Path: ${path()?.label}` : ""));
  $<HTMLElement>(".note").textContent = note;
  $<HTMLElement>(".note").classList.toggle("stuck", Boolean(stuck) && !skippingTo && !state.frozen);
  const play = $<HTMLButtonElement>("[data-do=play]");
  const isPlaying = state.playing || isSkipping();
  play.textContent = isPlaying ? "❚❚" : "▶";
  play.setAttribute("aria-label", isPlaying ? "Pause" : done ? "Play again" : "Play");
  $<HTMLButtonElement>("[data-do=prev]").disabled = state.chapter <= 0;
  $<HTMLButtonElement>("[data-do=next]").disabled = state.chapter >= count - 1;
  [...$<HTMLElement>(".bar").children].forEach((el, i) => {
    el.className = i < state.chapter ? "done" : i === state.chapter ? "current" : "";
  });
  jumpSelect.value = String(state.chapter);
  pathSelect.value = state.path ?? "";
}

root.addEventListener("click", (event) => {
  const action = (event.target as HTMLElement).closest("[data-do]")?.getAttribute("data-do");
  if (action === "play") {
    if (done) void restart({ playing: true });
    else if (state.playing || isSkipping()) set({ playing: false, target: null, frozen: true });
    else {
      set({ playing: true, frozen: false });
      void run();
    }
  } else if (action === "prev") goTo(state.chapter - 1);
  else if (action === "next") goTo(state.chapter + 1);
  else if (action === "replay") void restart({ playing: true });
  else if (action === "controls") {
    const panel = $<HTMLElement>(".controls");
    panel.hidden = !panel.hidden;
    $<HTMLButtonElement>("[data-do=controls]").setAttribute("aria-expanded", String(!panel.hidden));
  }
});
jumpSelect.addEventListener("change", () => goTo(Number(jumpSelect.value)));
pathSelect.addEventListener("change", () => void restart({ path: pathSelect.value || null, playing: true }));

// Using the page while it's paused takes over from the player: the page's clock runs again.
document.addEventListener(
  "pointerdown",
  (event) => {
    if (state.frozen && !event.composedPath().includes(host)) set({ frozen: false });
  },
  true
);

const mount = () => {
  document.body.append(host);
  syncClock();
  render();
  // Carry on after a page load: replay to where it was, move ahead to where it was going, or keep playing.
  if (interruptedAt !== null) void restart({ target: interruptedAt, playing: true });
  else if (state.target !== null || state.playing) void run();
};
if (document.body) mount();
else document.addEventListener("DOMContentLoaded", mount, { once: true });
