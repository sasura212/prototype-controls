// The flow review: every screen from the last screenshot tour, to go through one by one. A list of
// steps and errors on the left, the screen large in the middle (with before and after when it
// changed), and what changed, what the checks found, its comments and timing on the right.
import type { Issue } from "./checks";
import type { Comment } from "./comments";

type Shot = {
  name: string;
  kind: "step" | "error";
  title: string;
  file: string;
  /** The same screen in the tour before (new tours say; older ones are matched by name). */
  before?: string | null;
  /** Older tours worked the change out while shooting; new ones leave it to this page. */
  diff?: number | null;
  diffFile?: string | null;
  issues: Issue[];
  /** An error's path id, as the script has it (its name is a slug of it). Older tours don't say. */
  path?: string;
};
type Manifest = { run: string; at: string; viewport: string; shots: Shot[] };
type Item = Shot & { before: string | null; diff: number | null; comments: Comment[]; ms: number | null };
type Filter = "all" | "changed" | "issues" | "comments";
type Compare = "screen" | "side" | "slider" | "changes";

const url = (file: string) => `/__prototype/file?path=${encodeURIComponent(file)}`;
const escape = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
const get = async <T>(path: string, fallback: T): Promise<T> => {
  try {
    const response = await fetch(path);
    return response.ok ? await response.json() : fallback;
  } catch {
    return fallback;
  }
};
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
/** Under 0.5% is noise; under 5% is usually live content or an animation; past that, a real change. */
const level = (diff: number | null) =>
  diff === null ? "new" : diff >= 5 ? "changed" : diff >= 0.5 ? "slight" : "same";

// ------------------------------------------------------------------------------------------------
// The data: the last tour, the one before it (for "before"), timing and comments.
// ------------------------------------------------------------------------------------------------
const [manifest, timing, comments, runs] = await Promise.all([
  get<Manifest | null>(url("shots/latest/manifest.json"), null),
  get<Record<string, number>>(url("timing.json"), {}),
  get<Comment[]>("/__prototype/comments", []),
  get<string[]>("/__prototype/list?dir=shots", []),
]);

if (!manifest) {
  $("#review").hidden = true;
  $("#nothing").hidden = false;
  $("#meta").textContent = "Nothing to review yet";
  throw new Error("No tour yet");
}

const earlier = runs.filter((run) => run !== "latest" && run < manifest.run).sort();
const previousRun = earlier.at(-1) ?? null;
const previous = previousRun ? await get<Manifest | null>(url(`shots/${previousRun}/manifest.json`), null) : null;
const slowest = Math.max(1, ...Object.values(timing));

const items: Item[] = manifest.shots.map((shot) => ({
  ...shot,
  before: shot.before ?? previous?.shots.find((old) => old.name === shot.name)?.file ?? null,
  diff: shot.diff ?? null,
  comments: comments.filter((c) =>
    shot.kind === "step" ? c.step === shot.title && !c.path : c.path === (shot.path ?? shot.name.replace(/^error-/, ""))
  ),
  ms: shot.kind === "step" ? (timing[shot.title] ?? null) : null,
}));

// ------------------------------------------------------------------------------------------------
// What changed: compared here, pixel by pixel, against the tour before.
// ------------------------------------------------------------------------------------------------
const load = (file: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url(file);
  });
/** Draws both at `width` and marks what differs. Returns the share changed and the marked picture. */
const difference = async (before: string, now: string, width?: number) => {
  const [a, b] = await Promise.all([load(before), load(now)]);
  if (a.naturalWidth !== b.naturalWidth || a.naturalHeight !== b.naturalHeight) return { percent: 100, marked: null };
  const w = width ?? b.naturalWidth;
  const h = Math.round((b.naturalHeight * w) / b.naturalWidth);
  const draw = (img: HTMLImageElement) => {
    const canvas = document.createElement("canvas");
    [canvas.width, canvas.height] = [w, h];
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(img, 0, 0, w, h);
    return { canvas, context, data: context.getImageData(0, 0, w, h).data };
  };
  const old = draw(a);
  const fresh = draw(b);
  const out = fresh.context.getImageData(0, 0, w, h);
  let changed = 0;
  for (let i = 0; i < old.data.length; i += 4) {
    const delta =
      Math.abs(old.data[i] - fresh.data[i]) +
      Math.abs(old.data[i + 1] - fresh.data[i + 1]) +
      Math.abs(old.data[i + 2] - fresh.data[i + 2]);
    if (delta > 48) {
      changed++;
      out.data.set([240, 68, 56, 255], i);
    } else {
      // The unchanged parts, faded, so the red reads.
      for (let c = 0; c < 3; c++) out.data[i + c] = 255 - (255 - out.data[i + c]) * 0.3;
    }
  }
  fresh.context.putImageData(out, 0, 0);
  return { percent: Math.round((changed / (old.data.length / 4)) * 1000) / 10, marked: fresh.canvas };
};
const markedCache = new Map<string, string>();
const marked = async (item: Item) => {
  if (item.diffFile) return url(item.diffFile);
  if (!item.before) return null;
  if (!markedCache.has(item.name)) {
    const { marked: canvas } = await difference(item.before, item.file);
    if (canvas) markedCache.set(item.name, canvas.toDataURL("image/png"));
  }
  return markedCache.get(item.name) ?? null;
};
// The badges: a quick pass at small size for every screen that doesn't know yet.
void (async () => {
  for (const item of items) {
    if (item.diff !== null || !item.before) continue;
    try {
      item.diff = (await difference(item.before, item.file, 480)).percent;
    } catch {
      item.before = null;
    }
  }
  draw();
})();

const REVIEWED_KEY = `prototype-reviewed-${manifest.run}`;
let reviewed = new Set<string>();
try {
  reviewed = new Set(JSON.parse(localStorage.getItem(REVIEWED_KEY) ?? "[]"));
} catch {
  // Storage blocked: ticks last until the page reloads.
}
const saveReviewed = () => {
  try {
    localStorage.setItem(REVIEWED_KEY, JSON.stringify([...reviewed]));
  } catch {
    // Storage blocked.
  }
};

let filter: Filter = "all";
let view: "review" | "grid" = "review";
let compare: Compare = "screen";
let selected = Math.max(
  0,
  items.findIndex((item) => level(item.diff) === "changed" || item.issues.length)
);

const matchesWith = (item: Item, f: Filter) =>
  f === "all" ||
  (f === "changed" && level(item.diff) === "changed") ||
  (f === "issues" && item.issues.length > 0) ||
  (f === "comments" && item.comments.length > 0);
const matches = (item: Item) => matchesWith(item, filter);
const shown = () => items.map((item, index) => ({ item, index })).filter(({ item }) => matches(item));

// ------------------------------------------------------------------------------------------------
// The top: what this tour was, and filters that double as the summary.
// ------------------------------------------------------------------------------------------------
const count = (f: Filter) => items.filter((item) => matchesWith(item, f)).length;
$("#meta").textContent =
  `${new Date(manifest.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} · ${manifest.viewport} · ${previousRun ? "compared with the tour before" : "first tour, nothing to compare yet"}`;

function drawChips() {
  const labels: [Filter, string][] = [
    ["all", "All screens"],
    ["changed", "Changed"],
    ["issues", "To check"],
    ["comments", "Comments"],
  ];
  $(".chips").innerHTML = labels
    .map(
      ([f, label]) =>
        `<button class="chip" data-filter="${f}" aria-pressed="${filter === f}"><b>${count(f)}</b> ${label}</button>`
    )
    .join("");
}

// ------------------------------------------------------------------------------------------------
// The list.
// ------------------------------------------------------------------------------------------------
const marks = (item: Item) => {
  const out: string[] = [];
  const l = level(item.diff);
  if (l === "changed") out.push(`<span class="mark changed">${escape(String(item.diff))}% changed</span>`);
  if (l === "slight") out.push(`<span class="mark slight">slight change</span>`);
  if (l === "new") out.push(`<span class="mark new">new</span>`);
  if (item.issues.length) out.push(`<span class="mark issues">${item.issues.length} to check</span>`);
  if (item.comments.length)
    out.push(
      `<span class="mark comments">${item.comments.length} ${item.comments.length === 1 ? "comment" : "comments"}</span>`
    );
  if (reviewed.has(item.name)) out.push(`<span class="mark done">✓ reviewed</span>`);
  return out.join("");
};

function drawRail() {
  const list = shown();
  const group = (kind: Item["kind"], title: string) => {
    const rows = list.filter(({ item }) => item.kind === kind);
    if (!rows.length) return "";
    const done = rows.filter(({ item }) => reviewed.has(item.name)).length;
    return `<div class="group"><h2><span>${title}</span><span>${done}/${rows.length}</span></h2>${rows
      .map(
        ({
          item,
          index,
        }) => `<button class="row${reviewed.has(item.name) ? " reviewed" : ""}" data-index="${index}" aria-current="${index === selected}">
          <img class="thumb" src="${url(item.file)}" alt="" loading="lazy" />
          <span class="rowText"><span class="rowTitle">${escape(item.title)}</span><span class="marks">${marks(item)}</span></span>
        </button>`
      )
      .join("")}</div>`;
  };
  $(".rail").innerHTML =
    group("step", "Steps") + group("error", "Errors and edge cases") ||
    `<p class="empty" style="padding:24px">Nothing matches this filter.</p>`;
  $(".rail").querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
}

// ------------------------------------------------------------------------------------------------
// The stage: the screen, or before and after.
// ------------------------------------------------------------------------------------------------
function drawStage() {
  const item = items[selected];
  const list = shown();
  const position = list.findIndex(({ index }) => index === selected);
  $("#stageTitle").textContent = item.title;
  $("#stageSub").textContent =
    `${item.kind === "step" ? `Step ${items.filter((i) => i.kind === "step").indexOf(item) + 1}` : "Error or edge case"} · ${position + 1} of ${list.length}`;
  $<HTMLButtonElement>("#prev").disabled = position <= 0;
  $<HTMLButtonElement>("#next").disabled = position >= list.length - 1;

  const canCompare = Boolean(item.before) && item.diff !== null && level(item.diff) !== "same";
  if (!canCompare) compare = "screen";
  const modes: [Compare, string][] = canCompare
    ? [
        ["screen", "Screen"],
        ["side", "Side by side"],
        ["slider", "Slider"],
        ["changes", "Changes"],
      ]
    : [];
  $("#compare").hidden = !canCompare;
  $("#compare").innerHTML = modes
    .map(([mode, label]) => `<button data-compare="${mode}" aria-pressed="${compare === mode}">${label}</button>`)
    .join("");

  const canvas = $("#canvas");
  canvas.classList.remove("actual");
  if (compare === "side" && item.before) {
    canvas.innerHTML = `<div class="pair">
      <figure><figcaption>Before</figcaption><img src="${url(item.before)}" alt="Before" /></figure>
      <figure><figcaption>Now</figcaption><img src="${url(item.file)}" alt="Now" /></figure></div>`;
  } else if (compare === "slider" && item.before) {
    canvas.innerHTML = `<div class="slider" id="slider">
      <img src="${url(item.before)}" alt="Before" />
      <img class="after" src="${url(item.file)}" alt="Now" />
      <span class="divider"></span>
      <span class="label" style="left:10px">Before</span><span class="label" style="right:10px">Now</span></div>`;
    wireSlider();
  } else if (compare === "changes") {
    canvas.innerHTML = `<p class="empty">Marking what changed…</p>`;
    void marked(item).then((src) => {
      if (items[selected] !== item || compare !== "changes") return;
      canvas.innerHTML = src
        ? `<img class="shot" src="${src}" alt="Where it changed, in red" />`
        : `<p class="empty">The two screens are different sizes, so they can't be compared pixel by pixel.</p>`;
      canvas
        .querySelectorAll<HTMLImageElement>(".shot")
        .forEach((img) => (img.complete ? fit(img) : img.addEventListener("load", () => fit(img), { once: true })));
    });
    return;
  } else {
    canvas.innerHTML = `<img class="shot" src="${url(item.file)}" alt="${escape(item.title)}" title="Click for actual size" />`;
  }
  canvas.insertAdjacentHTML("beforeend", `<span class="hint">← → to move · R to mark reviewed</span>`);
  canvas.querySelectorAll<HTMLImageElement>(".shot, .slider img:not(.after)").forEach((img) => {
    if (img.complete) fit(img);
    else img.addEventListener("load", () => fit(img), { once: true });
  });
}

/** Scales a screen to fill the stage, up or down, keeping its proportions (like a viewer's "Fit"). */
function fit(img: HTMLImageElement) {
  const canvas = $("#canvas");
  if (canvas.classList.contains("actual") || !img.naturalWidth) return;
  const room = canvas.getBoundingClientRect();
  const scale = Math.min((room.width - 48) / img.naturalWidth, (room.height - 40) / img.naturalHeight);
  const target = img.closest<HTMLElement>(".slider") ?? img;
  target.style.width = `${Math.round(img.naturalWidth * scale)}px`;
  if (target !== img) img.style.width = "100%";
}
addEventListener("resize", () =>
  document.querySelectorAll<HTMLImageElement>(".shot, .slider img:not(.after)").forEach(fit)
);

function wireSlider() {
  const slider = $("#slider");
  const move = (event: PointerEvent) => {
    const rect = slider.getBoundingClientRect();
    const split = Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100));
    slider.style.setProperty("--split", `${split}%`);
  };
  slider.addEventListener("pointerdown", (event) => {
    slider.setPointerCapture?.(event.pointerId);
    move(event);
    slider.addEventListener("pointermove", move);
    slider.addEventListener("pointerup", () => slider.removeEventListener("pointermove", move), { once: true });
  });
}

// ------------------------------------------------------------------------------------------------
// The inspector: what changed, what to check, comments, timing, and the review tick.
// ------------------------------------------------------------------------------------------------
function drawInspector() {
  const item = items[selected];
  const l = level(item.diff);
  const changed =
    l === "new"
      ? "<p>New this tour: nothing to compare with yet.</p>"
      : `<div class="big">${escape(String(item.diff))}%</div><p>${
          l === "changed"
            ? "of the screen changed since the tour before."
            : l === "slight"
              ? "changed. Small changes like this are usually live content or an animation."
              : "No visible change since the tour before."
        }</p>`;
  const issues = item.issues.length
    ? `<ul class="list">${item.issues.map((issue) => `<li class="issue">${escape(issue.message)}</li>`).join("")}</ul>`
    : "<p>Nothing found on this screen.</p>";
  const notes = item.comments.length
    ? `<ul class="list">${item.comments
        .map(
          (c) =>
            `<li class="comment"><small>${escape(c.id)} · ${c.status}</small>${escape(c.text)}${c.replies
              .map((r) => `<div class="reply"><b>${escape(r.by === "you" ? "You" : r.by)}:</b> ${escape(r.text)}</div>`)
              .join("")}</li>`
        )
        .join("")}</ul>`
    : "<p>No comments on this screen. Leave one with 💬 on the player.</p>";
  const time =
    item.ms === null
      ? ""
      : `<div class="section"><h3>Time at 1×</h3><div class="big">${(item.ms / 1000).toFixed(1)}s</div>
         <div class="timebar${item.ms === slowest ? " slowest" : ""}"><span style="width:${(item.ms / slowest) * 100}%"></span></div>
         <p style="margin-top:6px">${item.ms === slowest ? "The slowest step in the flow." : `Slowest step: ${(slowest / 1000).toFixed(1)}s.`}</p></div>`;
  const isDone = reviewed.has(item.name);
  $("#inspector").innerHTML = `
    <div class="section"><button class="reviewButton${isDone ? " isDone" : ""}" data-review>${isDone ? "✓ Reviewed" : "Mark as reviewed"}</button></div>
    <div class="section"><h3>What changed</h3>${changed}</div>
    <div class="section"><h3>To check</h3>${issues}</div>
    <div class="section"><h3>Comments</h3>${notes}</div>
    ${time}`;
}

// ------------------------------------------------------------------------------------------------
// The grid: every screen at once, large, at its real proportions.
// ------------------------------------------------------------------------------------------------
function drawGrid() {
  const list = shown();
  const cards = (kind: Item["kind"]) =>
    list
      .filter(({ item }) => item.kind === kind)
      .map(
        ({ item, index }) => `<button class="card" data-index="${index}">
          <img class="thumb" src="${url(item.file)}" alt="" loading="lazy" />
          <span class="rowText"><span class="rowTitle">${escape(item.title)}</span><span class="marks">${marks(item)}</span></span>
        </button>`
      )
      .join("");
  const steps = cards("step");
  const errors = cards("error");
  $("#grid").innerHTML =
    (steps ? `<h2>Steps</h2><div class="cards">${steps}</div>` : "") +
      (errors ? `<h2>Errors and edge cases</h2><div class="cards">${errors}</div>` : "") ||
    `<p class="empty">Nothing matches this filter.</p>`;
}

function draw() {
  drawChips();
  $("#review").hidden = view !== "review";
  $("#grid").hidden = view !== "grid";
  document
    .querySelectorAll("[data-view]")
    .forEach((b) => b.setAttribute("aria-pressed", String((b as HTMLElement).dataset.view === view)));
  if (view === "review") {
    drawRail();
    drawStage();
    drawInspector();
  } else drawGrid();
}

const go = (step: number) => {
  const list = shown();
  const position = list.findIndex(({ index }) => index === selected);
  const next = list[position + step];
  if (next) {
    selected = next.index;
    draw();
  }
};

document.body.addEventListener("click", (event) => {
  const el = (event.target as HTMLElement).closest<HTMLElement>(
    "[data-filter], [data-view], [data-index], [data-compare], [data-review], .shot, #prev, #next"
  );
  if (!el) return;
  if (el.dataset.filter) {
    filter = el.dataset.filter as Filter;
    const first = shown()[0];
    if (first && !matches(items[selected])) selected = first.index;
  } else if (el.dataset.view) view = el.dataset.view as typeof view;
  else if (el.dataset.index) {
    selected = Number(el.dataset.index);
    view = "review";
  } else if (el.dataset.compare) compare = el.dataset.compare as Compare;
  else if (el.dataset.review !== undefined) {
    const name = items[selected].name;
    // Ticking one moves on to the next, the way a review queue does.
    const isTicking = !reviewed.has(name);
    if (isTicking) reviewed.add(name);
    else reviewed.delete(name);
    saveReviewed();
    draw();
    if (isTicking) go(1);
    return;
  } else if (el.classList.contains("shot")) {
    // Fit, or actual size to inspect detail.
    const canvas = $("#canvas");
    canvas.classList.toggle("actual");
    if (canvas.classList.contains("actual")) (el as HTMLImageElement).style.width = "";
    if (!canvas.classList.contains("actual")) fit(el as HTMLImageElement);
    return;
  } else if (el.id === "prev") return go(-1);
  else if (el.id === "next") return go(1);
  draw();
});

// A clamped reply opens in full on click.
document.body.addEventListener("click", (event) => {
  (event.target as HTMLElement).closest(".reply")?.classList.toggle("open");
});

document.addEventListener("keydown", (event) => {
  if (view !== "review" || event.metaKey || event.ctrlKey) return;
  if (event.key === "ArrowRight" || event.key === "j") go(1);
  if (event.key === "ArrowLeft" || event.key === "k") go(-1);
  if (event.key === "r") document.querySelector<HTMLElement>("[data-review]")?.click();
});

draw();
