// Prototype player, on top of a flow. Local only: `.prototype/` is listed in .git/info/exclude and
// added to the page by .prototype/vite.config.mjs, so nothing here is committed or pushed.
//
// It plays `script.ts` by driving the real page: it waits for what a person would see, then clicks
// and types the way they would. It also holds the page's clock, so pause freezes the page (its
// timers, animations and Date.now) like a paused video, and skipping runs that clock fast.
import script from "./script";
import css from "./overlay.css?inline";
import { audit, type Issue, type WordingRule } from "./checks";
import { setUpComments } from "./comments";
import { icon } from "./icons";

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
  /** The chapter the flow is on when `start` opens: the ones before it are already behind. */
  at?: string;
  /** The message this path is for. Picking the path plays fast up to it, then pauses there to read. */
  shows?: string;
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
  /** Error states found in the code that nothing outside the flow can reach, and why: listed, greyed. */
  unreachable?: { label: string; why: string }[];
  /** "What if": switch the mock backend (slow, empty, failing) and reload. */
  scenarios?: { id: string; label: string; set: () => Promise<void> | void }[];
  /** The style guide's ruled-out words, checked by "Check this screen". */
  wording?: WordingRule[];
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

  /** Every running CSS animation at the clock's speed; new ones are caught by the check below. */
  const matchAnimations = () => {
    for (const animation of document.getAnimations())
      if (animation.playbackRate !== speed && speed !== 0) animation.playbackRate = speed;
  };
  real.setTimeout(function keepUp() {
    if (speed !== 1 && speed !== 0) matchAnimations();
    real.setTimeout(keepUp, 50);
  }, 50);

  return {
    set(next: number) {
      if (next === speed) return;
      pageAt = now();
      realAt = real.now();
      const wasStill = speed === 0;
      speed = next;
      timers.forEach(arm);
      // CSS animations and transitions keep the same time as the rest of the page: faster or slower.
      if (next !== 0) matchAnimations();
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
  /** Playing fast until this text is on the page, then pausing there (a path's message). */
  stopAt: string | null;
  /** Playback speed: the page's clock and the player's beats run this much faster. */
  rate: number;
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
  stopAt: null,
  rate: 1,
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
 * The page reloaded while playing (a dev-server reload, an edit to the script). The flow has lost its
 * place, so the player doesn't race off to catch up by itself: it stops, and offers to go back to the
 * step it was on. The flow's own page loads carry on as they are.
 */
const isReload =
  (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type === "reload";
let resumeAt = state.target === null && state.playing && isReload ? state.chapter : null;
// A load that wasn't headed anywhere is a fresh visit (or a reload): start at the top, stopped.
if (state.target === null && (!state.playing || resumeAt !== null)) state = { ...fresh, rate: state.rate };
let stuck: string | null = null;
/** How long each chapter takes at 1×, played (not skipped), without the time spent paused. */
const timings: Record<string, number> = {};
let issues: Issue[] | null = null;
let done = false;
let skipWaits = 0;
/** What a long wait is fast-forwarding to, said on the bar so the rush reads as meant. */
let fastFor: string | null = null;
let running = false;
let generation = 0;
let wake: (() => void) | null = null;

const isSkipping = () => state.target !== null && state.chapter < state.target;
const path = () => script.paths?.find((item) => item.id === state.path) ?? null;
const syncClock = () => clock.set(state.frozen ? 0 : isSkipping() || skipWaits > 0 ? FAST : state.rate);
const save = () => {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage blocked: the player still works until the page reloads.
  }
};
let frozenSince: number | null = null;
let frozenMs = 0;
const set = (next: Partial<Saved>) => {
  if (next.frozen === true && !state.frozen) frozenSince = real.now();
  if (next.frozen === false && state.frozen && frozenSince !== null) {
    frozenMs += real.now() - frozenSince;
    frozenSince = null;
  }
  state = { ...state, ...next };
  save();
  syncClock();
  render();
  wake?.();
};

class Stop extends Error {}
const realSleep = (ms: number) => new Promise<void>((resolve) => real.setTimeout(resolve, ms));

/** Stops on a path's message once it's on screen: the page freezes there, ready to read. */
function checkStop() {
  if (!state.stopAt || !norm(document.body?.innerText).includes(norm(state.stopAt))) return;
  // Back to normal speed first, so the message finishes arriving (a fade, a slide), then freeze.
  set({ stopAt: null, target: null, playing: false });
  real.setTimeout(() => {
    if (!state.playing && !isSkipping()) set({ frozen: true });
  }, 800);
}

/** Holds while paused; returns at once while playing or moving ahead. */
const gate = async (mine: number) => {
  checkStop();
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

/** What a person can act on: the open dialog if there is one (it covers the rest), else the page. */
const scope = (): ParentNode => {
  const dialogs = [...document.querySelectorAll("[role=dialog], [role=alertdialog], dialog[open]")].filter(isShown);
  return dialogs.at(-1) ?? document;
};
const pick = <T extends Element>(all: T[], names: (el: T) => string[], want: string) =>
  all.find((el) => names(el).some((name) => norm(name) === want)) ??
  all.find((el) => names(el).some((name) => norm(name).includes(want)));
const findClickable = (wanted: Target) => {
  const target = aliased(wanted);
  if (typeof target !== "string") return document.querySelector<HTMLElement>(target.css);
  const all = [...scope().querySelectorAll<HTMLElement>(CLICKABLE)].filter(isShown);
  return pick(all, (el) => [el.innerText, el.getAttribute("aria-label") ?? "", el.title], norm(target)) ?? null;
};
const findField = (wanted: Target) => {
  const target = aliased(wanted);
  if (typeof target !== "string") return document.querySelector<HTMLElement>(target.css);
  const all = [...scope().querySelectorAll<HTMLElement>(FIELDS)].filter(isShown);
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

/** Saves a file into `.prototype/` through the player's server. */
const saveFile = (relative: string, data: BodyInit) =>
  fetch(`/__prototype/file?path=${encodeURIComponent(relative)}`, { method: "POST", body: data }).catch(
    () => undefined
  );

/** A label renamed since the script was written, answered from the bar: "use this instead". Kept in aliases.json. */
let aliases: Record<string, string> = {};
void fetch("/__prototype/file?path=aliases.json")
  .then((response) => (response.ok ? response.json() : {}))
  .then((saved) => (aliases = saved))
  .catch(() => undefined);
const aliased = (target: Target): Target => (typeof target === "string" ? (aliases[target] ?? target) : target);

/** When a step is stuck: the labels on screen that look most like the one it wants. */
let suggestions: { target: string; options: string[] } | null = null;
const similarity = (a: string, b: string) => {
  const [x, y] = [new Set(norm(a).split(" ")), new Set(norm(b).split(" "))];
  const shared = [...x].filter((word) => y.has(word)).length;
  return shared / Math.max(x.size, y.size) + (norm(b).includes(norm(a)) || norm(a).includes(norm(b)) ? 0.5 : 0);
};
const lookAlikes = (target: Target, kind: "click" | "type") => {
  if (typeof target !== "string") return;
  const names =
    kind === "click"
      ? [...scope().querySelectorAll<HTMLElement>(CLICKABLE)]
          .filter(isShown)
          .map((el) => el.innerText || el.getAttribute("aria-label") || "")
      : [...scope().querySelectorAll<HTMLElement>(FIELDS)]
          .filter(isShown)
          .map((el) => el.getAttribute("placeholder") || el.getAttribute("aria-label") || "");
  const options = [...new Set(names.map((name) => name.trim()).filter((name) => name && name.length < 60))]
    .map((name) => ({ name, score: similarity(target, name) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ name }) => name);
  suggestions = options.length ? { target, options } : null;
  render();
};

/** Polls until `find` returns something, saying what it waits on once it's been a while. */
const until = async <T>(
  find: () => T | null | undefined,
  what: string,
  mine: number,
  timeoutMs = FIND_MS,
  whenStuck?: () => void
) => {
  const started = real.now();
  for (;;) {
    if (mine !== generation) throw new Stop();
    const found = find();
    checkStop();
    if (found) {
      if (stuck || suggestions) {
        stuck = null;
        suggestions = null;
        render();
      }
      return found;
    }
    if (real.now() - started > timeoutMs && !stuck) {
      stuck = `Waiting for ${what}`;
      whenStuck?.();
      render();
    }
    await realSleep(100);
  }
};

const valueOf = (el: HTMLElement) => (el.isContentEditable ? (el.textContent ?? "") : (el as HTMLInputElement).value);
const setValue = (el: HTMLElement, value: string, data: string | null = null) => {
  if (el.isContentEditable) el.textContent = value;
  else {
    // React tracks the value itself: set it through the native setter so the change is seen.
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  }
  el.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: data === null ? "deleteContent" : "insertText",
      data,
    })
  );
};
/** A key event as the keyboard sends it. False when the page cancelled it (preventDefault). */
const sendKey = (el: Element, type: string, name: string) =>
  el.dispatchEvent(new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true, composed: true }));
/**
 * A press with the mouse, the whole way a browser sends it: over, down, focus, up, then one click,
 * at the element's centre. Menus (Radix DropdownMenu) open on pointerdown; most things on click.
 */
const mouseClick = (el: HTMLElement) => {
  const rect = el.getBoundingClientRect();
  const at = {
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    screenX: screenX + rect.left + rect.width / 2,
    screenY: screenY + rect.top + rect.height / 2,
    button: 0,
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
  };
  const pointer = { ...at, pointerId: 1, pointerType: "mouse", isPrimary: true };
  el.dispatchEvent(new PointerEvent("pointerover", pointer));
  el.dispatchEvent(new PointerEvent("pointerenter", { ...pointer, bubbles: false, cancelable: false }));
  // A cancelled pointerdown holds back the mouse events that follow it, but not the click.
  const isDown = el.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, buttons: 1 }));
  if (isDown && el.dispatchEvent(new MouseEvent("mousedown", { ...at, buttons: 1, detail: 1 }))) {
    const focusable = el.closest<HTMLElement>("a[href], button, input, select, textarea, summary, [tabindex]");
    if (focusable) focusable.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
  }
  el.dispatchEvent(new PointerEvent("pointerup", pointer));
  if (isDown) el.dispatchEvent(new MouseEvent("mouseup", { ...at, detail: 1 }));
  el.dispatchEvent(new MouseEvent("click", { ...at, detail: 1 }));
};
const FOCUSABLE =
  "a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex], [contenteditable=true]";
/** Tab: focus moves to the next thing in the page's order. */
// ponytail: document order only; positive tabindex values and shadow roots aren't ordered the way a browser would.
const tabForward = () => {
  const all = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && isShown(el)
  );
  all[(all.indexOf(document.activeElement as HTMLElement) + 1) % all.length]?.focus();
};

const pageFor = (mine: number): Page => {
  const beforeAct = async () => {
    await gate(mine);
    await sleep(beat / state.rate, mine);
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
        mine,
        FIND_MS,
        () => lookAlikes(target, "click")
      );
      await gate(mine);
      el.scrollIntoView({ block: "nearest" });
      ringAt(el);
      await sleep(250, mine);
      mouseClick(el);
    },
    async type(target, text) {
      await beforeAct();
      const el = await until(
        () => findField(target),
        describe(target),
        mine,
        FIND_MS,
        () => lookAlikes(target, "type")
      );
      el.scrollIntoView({ block: "nearest" });
      el.focus();
      // Typing replaces what's there, like selecting it all first.
      let field = el;
      let fresh = true;
      for (const char of text) {
        // Skipping: no pause between keys, but the same events, so the page sees typing either way.
        await gate(mine);
        // Each key the page can cancel, as a browser lets it: then the character doesn't go in.
        if (sendKey(field, "keydown", char)) {
          const before = fresh ? "" : valueOf(field);
          const isFull =
            (field as HTMLInputElement).maxLength > 0 && before.length >= (field as HTMLInputElement).maxLength;
          const isAllowed = field.dispatchEvent(
            new InputEvent("beforeinput", {
              inputType: "insertText",
              data: char,
              bubbles: true,
              cancelable: true,
              composed: true,
            })
          );
          if (isAllowed && !isFull) {
            if (fresh && valueOf(field)) setValue(field, "");
            setValue(field, before + char, char);
            fresh = false;
          }
        }
        sendKey(field, "keyup", char);
        // A code split over one-character boxes: the page moves focus on, and typing follows it.
        if ((field as HTMLInputElement).maxLength === 1) {
          if (isSkipping()) await realSleep(0);
          const next = document.activeElement as HTMLElement | null;
          if (next && next !== field && next.matches(FIELDS)) {
            field.dispatchEvent(new Event("change", { bubbles: true }));
            field = next;
            fresh = true;
          }
        }
        await sleep(35 / state.rate, mine);
      }
      field.dispatchEvent(new Event("change", { bubbles: true }));
    },
    async press(key) {
      await gate(mine);
      const el = (document.activeElement as HTMLElement | null) ?? document.body;
      if (sendKey(el, "keydown", key)) {
        // Printable keys (and Enter) send a keypress too; what a key does happens only if keydown wasn't cancelled.
        if (key.length === 1 || key === "Enter") sendKey(el, "keypress", key);
        if (key === "Tab") tabForward();
        if (key === "Enter" && el instanceof HTMLInputElement) el.form?.requestSubmit();
      }
      // The key comes up wherever focus is now (after Tab, the next field).
      sendKey(document.activeElement ?? document.body, "keyup", key);
    },
    waitFor,
    async skipUntil(target, timeoutMs) {
      skipWaits++;
      fastFor = typeof target === "string" ? target : null;
      syncClock();
      render();
      try {
        await waitFor(target, timeoutMs);
      } finally {
        skipWaits--;
        fastFor = null;
        syncClock();
        render();
      }
    },
    async wait(ms) {
      await gate(mine);
      await sleep(ms / state.rate, mine);
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
      const isTimed = state.playing && !isSkipping();
      const began = real.now();
      frozenMs = 0;
      await (path()?.chapters[chapter.title] ?? chapter.run)(pageFor(mine));
      if (mine !== generation) return;
      if (isTimed && !isSkipping()) timings[chapter.title] = Math.round((real.now() - began - frozenMs) * state.rate);
      const next = state.chapter + 1;
      if (next >= script.chapters.length) break;
      const arrived = state.target !== null && next >= state.target;
      // Arriving where it was headed: carry on if it was playing. If not, hold there frozen, once the
      // screen has finished arriving (a fade, a slide), so what's held is what a person would see.
      set({ chapter: next, target: arrived ? null : state.target });
      if (arrived && !state.playing)
        real.setTimeout(() => {
          if (!state.playing && !isSkipping() && state.chapter === next) set({ frozen: true });
        }, 800);
    }
    // Out of steps before the message showed: the flow may still be on its way there (a navigation, a
    // run), so give it a while on the fast clock before saying it never came.
    for (let waited = 0; state.stopAt && waited < 30_000; waited += 100) {
      checkStop();
      await realSleep(100);
    }
    if (mine !== generation) return;
    done = true;
    if (state.stopAt) stuck = `Never saw “${state.stopAt}”`;
    set({ playing: false, target: null, stopAt: null });
    if (Object.keys(timings).length) void saveFile("timing.json", JSON.stringify(timings, null, 2));
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
  const chosen = script.paths?.find((item) => item.id === (next.path !== undefined ? next.path : state.path));
  const from = Math.max(
    0,
    script.chapters.findIndex((chapter) => chapter.title === chosen?.at)
  );
  // Headed somewhere at least, so the reload knows it's a replay, not a fresh visit.
  set({ chapter: from, target: from, frozen: false, stopAt: null, ...next });
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
    return;
  }
  // Before where the path starts: back on the usual flow.
  const from = script.chapters.findIndex((chapter) => chapter.title === path()?.at);
  void restart({ target: to, playing: state.playing, ...(to < from ? { path: null } : {}) });
};
/** Opens a path at its message: plays fast up to it and pauses there. Play carries on from it. */
const showPath = (id: string | null) => {
  const chosen = script.paths?.find((item) => item.id === id);
  if (!chosen) return void restart({ path: null, playing: false });
  void restart({
    path: chosen.id,
    playing: false,
    // Past the last chapter, so every one plays fast until the message shows.
    ...(chosen.shows ? { target: script.chapters.length, stopAt: chosen.shows } : { playing: true }),
  });
};
// While playing up to a path's message: stop the moment it's on screen. Checked on a timer and
// whenever the player finds what it waited for, since skipping can move past a message within 100ms.
real.setTimeout(function watch() {
  checkStop();
  real.setTimeout(watch, 100);
}, 100);

// ------------------------------------------------------------------------------------------------
// The bar.
// ------------------------------------------------------------------------------------------------
const host = document.createElement("div");
host.setAttribute("data-prototype-overlay", "");
const root = host.attachShadow({ mode: "open" });
root.innerHTML = `<style>${css}</style>
<div class="ring"></div>
<section class="player" aria-label="Prototype player">
  <button class="grip" data-drag aria-label="Move the player. Double-click to put it back.">${icon.grip}</button>
  <span class="buttons">
    <button data-do="prev" aria-label="Previous step">${icon.prev}</button>
    <button data-do="play" class="play" aria-label="Play">${icon.play}</button>
    <button data-do="next" aria-label="Next step">${icon.next}</button>
  </span>
  <span class="now">
    <span class="label" aria-live="polite"></span>
    <span class="note"></span>
    <span class="bar"></span>
  </span>
  <span class="tools">
    <button data-do="replay" aria-label="Replay from the start">${icon.replay}</button>
    <button data-do="sendComments" class="sendComments" hidden>${icon.send}<span></span></button>
    <button data-do="comment" aria-label="Comment on something on the page">${icon.comment}<span class="count"></span></button>
    <button data-do="controls" aria-label="Prototype controls" aria-expanded="false">${icon.settings}</button>
    <button data-do="minimize" aria-label="Minimize the player">${icon.minimize}</button>
  </span>
  <div class="controls" hidden>
    <div class="suggest" hidden></div>
    <div class="tabs" role="tablist">
      <button role="tab" data-tab="play" aria-selected="true">Play</button>
      <button role="tab" data-tab="comments" aria-selected="false">Comments <span class="tabCount"></span></button>
      <button role="tab" data-tab="review" aria-selected="false">Review</button>
    </div>
    <div class="tab" data-panel="play">
      <label>Jump to <select data-do="jump"></select></label>
      <label>Errors and edge cases <select data-do="path"></select></label>
      <label class="scenarios">What if <select data-do="scenario"></select></label>
      <div class="field">Speed
        <span class="segments" role="radiogroup" aria-label="Speed">
          <button data-rate="0.5" role="radio">0.5×</button><button data-rate="1" role="radio">1×</button><button data-rate="2" role="radio">2×</button><button data-rate="4" role="radio">4×</button>
        </span>
      </div>
    </div>
    <div class="tab" data-panel="comments" hidden>
      <span class="segments filter" role="radiogroup" aria-label="Show">
        <button data-filter="open" role="radio">Open</button><button data-filter="resolved" role="radio">Resolved</button><button data-filter="all" role="radio">All</button>
      </span>
      <ul class="commentList"></ul>
      <button data-do="sendComments" class="wide primary" hidden>${icon.send} <span></span></button>
      <button data-do="comment" class="wide">${icon.comment} New comment</button>
    </div>
    <div class="tab" data-panel="review" hidden>
      <button data-do="check" class="wide">Check this screen</button>
      <ul class="issues" hidden></ul>
      <details class="timing"><summary>Timing at 1×</summary><ul></ul></details>
      <a href="/__prototype/studio" target="_blank" class="wide">${icon.studio} Open the studio ↗</a>
    </div>
  </div>
</section>
<button class="mini" hidden aria-label="Show the player">
  <svg class="miniRing" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="21"/><circle class="miniDone" cx="24" cy="24" r="21"/></svg>
  <span class="miniIcon"></span>
</button>`;
const $ = <T extends Element>(selector: string) => root.querySelector<T>(selector)!;
const ring = $<HTMLDivElement>(".ring");
const jumpSelect = $<HTMLSelectElement>("[data-do=jump]");
const pathSelect = $<HTMLSelectElement>("[data-do=path]");
const scenarioSelect = $<HTMLSelectElement>("[data-do=scenario]");
jumpSelect.innerHTML = script.chapters
  .map((c, i) => `<option value="${i}">${i + 1} · ${escapeHtml(c.title)}</option>`)
  .join("");
pathSelect.innerHTML = [
  `<option value="">None: the usual flow</option>`,
  ...(script.paths ?? []).map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`),
  ...(script.unreachable?.length
    ? [
        `<optgroup label="Can't be shown from outside the flow">`,
        ...script.unreachable.map(
          (u) => `<option disabled title="${escapeHtml(u.why)}">${escapeHtml(u.label)}: ${escapeHtml(u.why)}</option>`
        ),
        `</optgroup>`,
      ]
    : []),
].join("");
scenarioSelect.innerHTML = [
  `<option value="">As it is</option>`,
  ...(script.scenarios ?? []).map(
    (item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`
  ),
].join("");
$<HTMLElement>(".scenarios").hidden = !script.scenarios?.length;
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
  const player = $<HTMLElement>(".player");
  player.className = `player ${place.at ? "placed" : (chapter?.placement ?? script.placement ?? "left")}${!place.at || place.at.y > innerHeight / 2 ? "" : " below"}`;
  player.hidden = place.minimized;
  mini.hidden = !place.minimized;
  // The speed, whenever it isn't 1×, so a fast or slow play is never a surprise.
  $<HTMLElement>(".label").textContent =
    `${state.chapter + 1} of ${count} · ${chapter?.title ?? ""}${state.rate !== 1 ? ` · ${state.rate}×` : ""}`;
  const skippingTo = state.stopAt ? path()?.label : isSkipping() ? script.chapters[state.target ?? 0]?.title : null;
  const note = skippingTo
    ? `Going to ${skippingTo}…`
    : state.frozen
      ? ["Paused", path()?.label].filter(Boolean).join(" · ")
      : fastFor && skipWaits > 0
        ? `Fast-forwarding to “${fastFor}”…`
        : (stuck ?? path()?.label ?? "");
  const noteEl = $<HTMLElement>(".note");
  if (resumeAt !== null && !state.playing && !isSkipping()) {
    const to = script.chapters[resumeAt];
    noteEl.innerHTML = `<button data-do="resume" class="resume">Page reloaded · back to ${resumeAt + 1}. ${escapeHtml(to?.title ?? "")} →</button>`;
  } else noteEl.textContent = note;
  $<HTMLElement>(".note").classList.toggle("stuck", Boolean(stuck) && !skippingTo && !state.frozen);
  const play = $<HTMLButtonElement>("[data-do=play]");
  const isPlaying = state.playing || isSkipping();
  play.innerHTML = isPlaying ? icon.pause : icon.play;
  play.setAttribute("aria-label", isPlaying ? "Pause" : done ? "Play again" : "Play");
  // Minimized: a ring round the button fills as the flow goes.
  $<HTMLElement>(".miniIcon").innerHTML = isPlaying ? icon.pause : icon.play;
  const share = count > 1 ? state.chapter / (count - 1) : 1;
  $<SVGCircleElement>(".miniDone").style.strokeDashoffset = String(132 * (1 - share));
  mini.setAttribute("aria-label", `Show the player: ${state.chapter + 1} of ${count}, ${chapter?.title ?? ""}`);
  $<HTMLButtonElement>("[data-do=prev]").disabled = state.chapter <= 0;
  $<HTMLButtonElement>("[data-do=next]").disabled = state.chapter >= count - 1;
  [...$<HTMLElement>(".bar").children].forEach((el, i) => {
    el.className = i < state.chapter ? "done" : i === state.chapter ? "current" : "";
  });
  jumpSelect.value = String(state.chapter);
  pathSelect.value = state.path ?? "";
  root
    .querySelectorAll<HTMLElement>("[data-rate]")
    .forEach((b) => b.setAttribute("aria-checked", String(Number(b.dataset.rate) === state.rate)));
  root
    .querySelectorAll<HTMLElement>("[data-filter]")
    .forEach((b) => b.setAttribute("aria-checked", String(b.dataset.filter === commentFilter)));
  drawCommentList();

  // Stuck: what's on screen that looks like what it wants, one click to use it.
  const suggest = $<HTMLElement>(".suggest");
  suggest.hidden = !suggestions;
  if (suggestions) {
    suggest.innerHTML = `<p>Can't find “${escapeHtml(suggestions.target)}”. Use one of these instead?</p>${suggestions.options
      .map((option) => `<button data-alias="${escapeHtml(option)}">${escapeHtml(option)}</button>`)
      .join("")}`;
    openPanel("play");
  }
  const list = $<HTMLElement>(".issues");
  list.hidden = issues === null;
  list.innerHTML =
    issues === null
      ? ""
      : issues.length
        ? issues.map((issue, i) => `<li data-issue="${i}">${escapeHtml(issue.message)}</li>`).join("")
        : "<li>Nothing found on this screen.</li>";
  const times = Object.entries(timings);
  $<HTMLElement>(".timing ul").innerHTML = times.length
    ? times
        .map(([title, ms]) => `<li><span>${escapeHtml(title)}</span><span>${(ms / 1000).toFixed(1)}s</span></li>`)
        .join("")
    : "<li>Play the flow at any speed to time each step.</li>";
  comments?.redraw();
}

root.addEventListener("click", (event) => {
  const action = (event.target as HTMLElement).closest("[data-do]")?.getAttribute("data-do");
  if (action === "resume" && resumeAt !== null) {
    // Back to where it was before the reload: from the top, fast, then on from there.
    const to = resumeAt;
    resumeAt = null;
    void restart({ target: to, playing: true });
  } else if (action === "play") {
    // After a reload the flow has lost its place: Play starts it over rather than guessing.
    if (resumeAt !== null) {
      resumeAt = null;
      void restart({ playing: true });
    } else if (done) void restart({ playing: true });
    else if (state.playing || isSkipping()) set({ playing: false, target: null, frozen: true });
    else {
      set({ playing: true, frozen: false });
      void run();
    }
  } else if (action === "prev") goTo(state.chapter - 1);
  else if (action === "next") goTo(state.chapter + 1);
  else if (action === "replay") void restart({ playing: true });
  else if (action === "comment") comments?.startPicking();
  else if (action === "sendComments") void comments?.sendDrafts();
  else if (action === "minimize") setPlace({ minimized: true });
  else if (action === "check") {
    issues = audit(script.wording);
    render();
  } else if (action === "controls") {
    if ($<HTMLElement>(".controls").hidden) openPanel();
    else closePanel();
  }
});
jumpSelect.addEventListener("change", () => goTo(Number(jumpSelect.value)));
// The panel: tabs, speed, the comments list and its filter.
let commentFilter: "open" | "resolved" | "all" = "open";
function openPanel(tab?: string) {
  $<HTMLElement>(".controls").hidden = false;
  $<HTMLButtonElement>("[data-do=controls]").setAttribute("aria-expanded", "true");
  if (tab) showTab(tab);
}
function closePanel() {
  $<HTMLElement>(".controls").hidden = true;
  $<HTMLButtonElement>("[data-do=controls]").setAttribute("aria-expanded", "false");
}
function showTab(tab: string) {
  root
    .querySelectorAll<HTMLElement>("[data-tab]")
    .forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  root.querySelectorAll<HTMLElement>("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== tab));
}
function drawCommentList() {
  if (!comments) return;
  const all = comments.all();
  const shown = all
    .map((comment, index) => ({ comment, number: index + 1 }))
    // Drafts count as open: they're waiting on something too.
    .filter(
      ({ comment }) =>
        commentFilter === "all" || (comment.status === "draft" ? "open" : comment.status) === commentFilter
    );
  $<HTMLElement>(".tabCount").textContent = String(all.filter((c) => c.status === "open").length || "");
  $<HTMLElement>(".commentList").innerHTML = shown.length
    ? shown
        .map(
          ({ comment, number }) => `<li><button data-comment="${comment.id}">
            <span class="pinDot ${comment.status}${comment.replies.length ? " answered" : ""}">${number}</span>
            <span class="commentText"><span>${escapeHtml(comment.text)}</span>
            <small>${comment.status === "draft" ? "Draft · " : ""}${escapeHtml(comment.step ?? "")}${comment.replies.length ? ` · ${comment.replies.length} ${comment.replies.length === 1 ? "reply" : "replies"}` : ""}</small></span>
          </button></li>`
        )
        .join("")
    : `<li class="empty">${commentFilter === "open" ? "No open comments." : "Nothing here yet."}</li>`;
}
// A declaration, not a const: the bar's lists are filled (escaped) before this line runs.
function escapeHtml(text: string) {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}
root.addEventListener("click", (event) => {
  const el = (event.target as HTMLElement).closest<HTMLElement>(
    "[data-tab], [data-rate], [data-filter], [data-comment]"
  );
  if (!el) return;
  if (el.dataset.tab) showTab(el.dataset.tab);
  if (el.dataset.rate) set({ rate: Number(el.dataset.rate) });
  if (el.dataset.filter) {
    commentFilter = el.dataset.filter as typeof commentFilter;
    render();
  }
  if (el.dataset.comment) {
    // On this step: open its pin. On another: go there, and the pin is waiting.
    const comment = comments.all().find((c) => c.id === el.dataset.comment);
    const index = script.chapters.findIndex((c) => c.title === comment?.step);
    if (comment && (index === state.chapter || index < 0)) comments.open(comment.id);
    else if (index >= 0) goTo(index);
  }
});

// ------------------------------------------------------------------------------------------------
// Where the player sits: dragged anywhere by its grip (remembered), or minimized to a button.
// ------------------------------------------------------------------------------------------------
const mini = $<HTMLButtonElement>(".mini");
type Place = { at: { x: number; y: number } | null; minimized: boolean };
const PLACE_KEY = "prototype-overlay-place";
let place: Place = { at: null, minimized: false };
try {
  place = { ...place, ...JSON.parse(localStorage.getItem(PLACE_KEY) ?? "{}") };
} catch {
  // Storage blocked: the player starts in its usual spot.
}
function setPlace(next: Partial<Place>) {
  place = { ...place, ...next };
  try {
    localStorage.setItem(PLACE_KEY, JSON.stringify(place));
  } catch {
    // Storage blocked: the position lasts until the page reloads.
  }
  applyPlace();
  render();
}
/** Keeps the dragged player on screen, and opens the panel on whichever side has room. */
function applyPlace() {
  const player = $<HTMLElement>(".player");
  for (const el of [player, mini]) {
    if (!place.at) {
      el.style.left = el.style.top = el.style.right = el.style.bottom = "";
      continue;
    }
    const rect = (place.minimized ? mini : player).getBoundingClientRect();
    const x = Math.min(Math.max(place.at.x, 8), innerWidth - Math.max(rect.width, 48) - 8);
    const y = Math.min(Math.max(place.at.y, 8), innerHeight - Math.max(rect.height, 48) - 8);
    Object.assign(el.style, { left: `${x}px`, top: `${y}px`, right: "auto", bottom: "auto" });
  }
}
function startDrag(event: PointerEvent, el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  const offset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  const startedAt = { x: event.clientX, y: event.clientY };
  let moved = false;
  try {
    el.setPointerCapture(event.pointerId);
  } catch {
    // A synthetic pointer (a test, an automation) can't be captured; the drag still follows it.
  }
  const move = (e: PointerEvent) => {
    if (!moved && Math.hypot(e.clientX - startedAt.x, e.clientY - startedAt.y) < 4) return;
    moved = true;
    place = { ...place, at: { x: e.clientX - offset.x, y: e.clientY - offset.y } };
    applyPlace();
  };
  const end = () => {
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", end);
    el.removeEventListener("pointercancel", end);
    if (moved) setPlace({});
    // A tap on the minimized button (no drag) opens the player again.
    else if (el === mini) setPlace({ minimized: false });
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}
$<HTMLElement>(".grip").addEventListener("pointerdown", (event) => startDrag(event, $<HTMLElement>(".player")));
$<HTMLElement>(".grip").addEventListener("dblclick", () => setPlace({ at: null }));
mini.addEventListener("pointerdown", (event) => startDrag(event, mini));
addEventListener("resize", applyPlace);
scenarioSelect.addEventListener("change", async () => {
  await script.scenarios?.find((item) => item.id === scenarioSelect.value)?.set();
  location.reload();
});
root.addEventListener("click", (event) => {
  const el = event.target as HTMLElement;
  const alias = el.dataset.alias;
  if (alias && suggestions) {
    aliases = { ...aliases, [suggestions.target]: alias };
    void saveFile("aliases.json", JSON.stringify(aliases, null, 2));
    suggestions = null;
    render();
  }
  const issue = el.dataset.issue !== undefined ? issues?.[Number(el.dataset.issue)] : undefined;
  const target = issue ? document.querySelector(issue.selector) : null;
  if (target) {
    target.scrollIntoView({ block: "center" });
    ringAt(target);
  }
});
pathSelect.addEventListener("change", () => showPath(pathSelect.value || null));

// Using the page while it's paused takes over from the player: the page's clock runs again.
document.addEventListener(
  "pointerdown",
  (event) => {
    if (state.frozen && !event.composedPath().includes(host)) set({ frozen: false });
  },
  true
);

/**
 * A handle for checking the script from a browser tool (devtools, Playwright): drive the player and
 * read where it is, without clicking the bar. `window.__prototype.result()` says where it stopped.
 */
// Comments: anything on the page, sent to the agent.
const comments = setUpComments(
  root,
  host,
  () => ({ step: script.chapters[state.chapter]?.title ?? "", path: state.path }),
  real
);
comments.onChange((open, drafts) => {
  $<HTMLElement>(".count").textContent = open ? String(open) : "";
  // Drafts waiting: one button on the bar and one in the panel sends them all.
  root.querySelectorAll<HTMLElement>("[data-do=sendComments]").forEach((button) => {
    button.hidden = !drafts;
    const label = `Send ${drafts} ${drafts === 1 ? "comment" : "comments"} to Claude`;
    button.setAttribute("aria-label", label);
    button.querySelector("span")!.textContent = button.classList.contains("wide") ? label : `Send ${drafts}`;
  });
  drawCommentList();
});

Object.assign(window, {
  __prototype: {
    chapters: script.chapters.map((chapter) => chapter.title),
    paths: (script.paths ?? []).map(({ id, label, shows }) => ({ id, label, shows })),
    play: () => {
      if (!state.playing) root.querySelector<HTMLButtonElement>("[data-do=play]")?.click();
    },
    pause: () => {
      if (state.playing || isSkipping()) root.querySelector<HTMLButtonElement>("[data-do=play]")?.click();
    },
    goTo,
    showPath,
    replay: () => restart({ playing: true }),
    /** Back to the flow's first page, paused there. */
    restart: () => restart({ playing: false, path: null }),
    setRate: (rate: number) => set({ rate }),
    /** Hide the bar (for a clean screenshot) or show it again. */
    setHidden: (hidden: boolean) => (host.style.display = hidden ? "none" : ""),
    audit: () => audit(script.wording),
    timings: () => ({ ...timings }),
    comments: () => comments.all(),
    result: () => ({
      chapter: script.chapters[state.chapter]?.title,
      playing: state.playing,
      skipping: isSkipping(),
      paused: state.frozen,
      done,
      path: state.path,
      waitingFor: stuck,
      onScreen: state.path ? norm(document.body.innerText).includes(norm(path()?.shows)) : null,
    }),
  },
});

const mount = () => {
  document.body.append(host);
  syncClock();
  render();
  applyPlace();
  // Carry on after a page load: move ahead to where it was going, or keep playing.
  if (state.target !== null || state.playing) void run();
};
if (document.body) mount();
else document.addEventListener("DOMContentLoaded", mount, { once: true });
