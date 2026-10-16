// The contact sheet: the last screenshot tour, one card per step and per error, with what changed
// since the tour before and what "Check this screen" found. Plus timing and the comments.
import type { Issue } from "./checks";
import type { Comment } from "./comments";

type Shot = {
  name: string;
  kind: "step" | "error";
  title: string;
  file: string;
  diff: number | null;
  diffFile: string | null;
  issues: Issue[];
};
type Manifest = { run: string; at: string; viewport: string; shots: Shot[] };

const url = (file: string) => `/__prototype/file?path=${encodeURIComponent(file)}`;
const escape = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
const get = async <T>(path: string, fallback: T): Promise<T> => {
  const response = await fetch(path);
  return response.ok ? response.json() : fallback;
};

const [manifest, timing, comments] = await Promise.all([
  get<Manifest | null>(url("shots/latest/manifest.json"), null),
  get<Record<string, number>>(url("timing.json"), {}),
  get<Comment[]>("/__prototype/comments", []),
]);

const card = (shot: Shot) => `
  <article class="card">
    <img src="${url(shot.file)}" alt="${escape(shot.title)}" data-file="${shot.file}" data-diff="${shot.diffFile ?? ""}" />
    <div class="body">
      <span class="title">${escape(shot.title)}${
        shot.diff === null
          ? `<span class="badge">new</span>`
          : shot.diff >= 5
            ? `<span class="badge changed" data-toggle>${shot.diff}% changed</span>`
            : shot.diff >= 0.5
              ? // Live content and animations move a little between runs: small, so say so.
                `<span class="badge" data-toggle title="Often live content or an animation">slight change (${shot.diff}%)</span>`
              : `<span class="badge">unchanged</span>`
      }</span>
      ${shot.issues.length ? `<ul class="issues">${shot.issues.map((issue) => `<li>${escape(issue.message)}</li>`).join("")}</ul>` : ""}
    </div>
  </article>`;

const meta = document.querySelector("#meta")!;
if (!manifest) {
  meta.textContent = "No tour yet. In the studio, press “Screenshot every step and error”.";
} else {
  const changed = manifest.shots.filter((shot) => (shot.diff ?? 0) >= 5).length;
  const flagged = manifest.shots.reduce((sum, shot) => sum + shot.issues.length, 0);
  meta.textContent = `${new Date(manifest.at).toLocaleString()} · viewport ${manifest.viewport} · ${manifest.shots.length} screens · ${changed} changed since the tour before · ${flagged} things to check`;
  document.querySelector("#steps")!.innerHTML = manifest.shots
    .filter((s) => s.kind === "step")
    .map(card)
    .join("");
  document.querySelector("#errors")!.innerHTML =
    manifest.shots
      .filter((s) => s.kind === "error")
      .map(card)
      .join("") || `<p class="empty">No error paths in the script.</p>`;
}

const times = Object.entries(timing);
document.querySelector("#timing")!.innerHTML = times.length
  ? `<table>${times.map(([title, ms]) => `<tr><td>${escape(title)}</td><td>${(ms / 1000).toFixed(1)}s</td></tr>`).join("")}<tr><td><b>Total</b></td><td><b>${(times.reduce((sum, [, ms]) => sum + ms, 0) / 1000).toFixed(1)}s</b></td></tr></table>`
  : `<p class="empty">Play the flow once with the player to time each step.</p>`;

document.querySelector("#comments")!.innerHTML = comments.length
  ? comments
      .map(
        (c) =>
          `<div class="comment"><div class="where">${c.id} · ${c.status} · ${escape(c.step ?? "")}${c.path ? ` · ${escape(c.path)}` : ""}${c.target?.text ? ` · on “${escape(c.target.text.slice(0, 60))}”` : ""}</div>${escape(c.text)}${c.replies
            .map((r) => `<div class="where">↳ ${escape(r.by)}: ${escape(r.text)}</div>`)
            .join("")}</div>`
      )
      .join("")
  : `<p class="empty">No comments yet. Use 💬 on the player to leave one.</p>`;

// A changed badge flips the picture between the screen and where it changed; a click on a picture zooms.
const zoom = document.querySelector<HTMLDialogElement>("#zoom")!;
document.body.addEventListener("click", (event) => {
  const el = event.target as HTMLElement;
  if (el.matches("[data-toggle]")) {
    const img = el.closest(".card")!.querySelector("img")!;
    const showingDiff = img.src.includes(encodeURIComponent(".diff.png"));
    img.src = url(showingDiff ? img.dataset.file! : img.dataset.diff!);
  } else if (el.matches(".card img")) {
    zoom.querySelector("img")!.src = (el as HTMLImageElement).src;
    zoom.showModal();
  } else if (el === zoom) zoom.close();
});
