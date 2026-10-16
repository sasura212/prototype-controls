// The studio: the flow in a frame, sized as a phone, tablet or laptop, with recording and the
// screenshot tour. The frame's page is the real app with the player on it; the studio drives that
// player through `__prototype`. Captures come from the browser's own tab capture (one prompt per
// session), cropped to the frame.
import script from "./script";
import type { Issue } from "./checks";

type Result = { chapter?: string; skipping: boolean; paused: boolean; done: boolean; waitingFor: string | null };
type Player = {
  chapters: string[];
  paths: { id: string; label: string }[];
  play: () => void;
  goTo: (index: number) => void;
  showPath: (id: string) => void;
  restart: () => void;
  setHidden: (hidden: boolean) => void;
  audit: () => Issue[];
  result: () => Result;
};
type Shot = {
  name: string;
  kind: "step" | "error";
  title: string;
  file: string;
  diff: number | null;
  diffFile: string | null;
  issues: Issue[];
};

const frame = document.querySelector<HTMLIFrameElement>("iframe")!;
const status = document.querySelector<HTMLElement>("#status")!;
const recordButton = document.querySelector<HTMLButtonElement>("#record")!;
const tourButton = document.querySelector<HTMLButtonElement>("#tour")!;
frame.src = script.start;

const say = (html: string) => (status.innerHTML = html);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const frames = (count: number) =>
  new Promise<void>((resolve) => {
    const step = (left: number) => (left ? requestAnimationFrame(() => step(left - 1)) : resolve());
    step(count);
  });
const save = (relative: string, data: BodyInit) =>
  fetch(`/__prototype/file?path=${encodeURIComponent(relative)}`, { method: "POST", body: data });
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// Viewport: the frame at a device's size, or filling the studio.
document.querySelector(".sizes")!.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-size]");
  if (!button) return;
  document.querySelectorAll("[data-size]").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
  const [width, height] =
    button.dataset.size === "fit" ? ["100%", "100%"] : button.dataset.size!.split("x").map((n) => `${n}px`);
  Object.assign(frame.style, { width, height });
});

/** The player in the frame, once its page has loaded (it reloads for replays and error paths). */
const player = async (): Promise<Player> => {
  for (let i = 0; i < 300; i++) {
    const found = (frame.contentWindow as (Window & { __prototype?: Player }) | null)?.__prototype;
    if (found && frame.contentDocument?.readyState === "complete") return found;
    await sleep(100);
  }
  throw new Error("The player didn't load in the frame");
};
/** Waits until the player has stopped: paused where it was headed, done, or stuck for a while. */
const settled = async () => {
  let stuckSince: number | null = null;
  for (let waited = 0; waited < 120_000; waited += 250) {
    await sleep(250);
    const result = (await player()).result();
    stuckSince = result.waitingFor ? (stuckSince ?? waited) : null;
    if (!result.skipping && (result.paused || result.done || (stuckSince !== null && waited - stuckSince > 30_000)))
      return result;
  }
  return (await player()).result();
};

// Capture: the tab as a video stream, drawn cropped to the frame.
let stream: MediaStream | null = null;
const video = document.createElement("video");
video.muted = true;
const capture = async () => {
  if (!stream) {
    // SAFETY: preferCurrentTab and selfBrowserSurface are Chrome's options for capturing this tab.
    stream = await navigator.mediaDevices.getDisplayMedia({
      // As sharp as the screen allows: screenshots and recordings at full resolution.
      video: { displaySurface: "browser", width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: "include",
    } as DisplayMediaStreamOptions);
    stream.getVideoTracks()[0].addEventListener("ended", () => (stream = null));
    video.srcObject = stream;
    await video.play();
  }
};
const draw = (canvas: HTMLCanvasElement) => {
  const rect = frame.getBoundingClientRect();
  const scale = video.videoWidth / innerWidth;
  canvas.width = Math.round(rect.width * scale);
  canvas.height = Math.round(rect.height * scale);
  canvas
    .getContext("2d")!
    .drawImage(
      video,
      rect.left * scale,
      rect.top * scale,
      rect.width * scale,
      rect.height * scale,
      0,
      0,
      canvas.width,
      canvas.height
    );
};
const png = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/png"));

/** How much of the screen changed since the last tour, and a picture of where. */
const compare = async (current: HTMLCanvasElement, name: string) => {
  const previous = await fetch(`/__prototype/file?path=shots/latest/${name}.png`);
  if (!previous.ok) return { percent: null, image: null };
  const before = await createImageBitmap(await previous.blob());
  if (before.width !== current.width || before.height !== current.height) return { percent: 100, image: null };
  const old = document.createElement("canvas");
  [old.width, old.height] = [before.width, before.height];
  const oldContext = old.getContext("2d")!;
  oldContext.drawImage(before, 0, 0);
  const a = oldContext.getImageData(0, 0, old.width, old.height).data;
  const b = current.getContext("2d")!.getImageData(0, 0, current.width, current.height).data;
  const out = document.createElement("canvas");
  [out.width, out.height] = [current.width, current.height];
  const outContext = out.getContext("2d")!;
  outContext.globalAlpha = 0.25;
  outContext.drawImage(current, 0, 0);
  const marks = outContext.getImageData(0, 0, out.width, out.height);
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 48) {
      changed++;
      marks.data.set([240, 68, 56, 255], i);
    }
  }
  outContext.putImageData(marks, 0, 0);
  return { percent: Math.round((changed / (a.length / 4)) * 1000) / 10, image: changed ? out : null };
};

const shoot = async (run: string, name: string, kind: Shot["kind"], title: string): Promise<Shot> => {
  const p = await player();
  const issues = p.audit();
  p.setHidden(true);
  // The tab capture runs a few frames behind the page: let it catch up before drawing.
  await sleep(350);
  await frames(2);
  const canvas = document.createElement("canvas");
  draw(canvas);
  p.setHidden(false);
  const { percent, image } = await compare(canvas, name);
  const file = `shots/${run}/${name}.png`;
  const blob = await png(canvas);
  await save(file, blob);
  await save(`shots/latest/${name}.png`, blob);
  const diffFile = image ? `shots/${run}/${name}.diff.png` : null;
  if (image && diffFile) await save(diffFile, await png(image));
  return { name, kind, title, file, diff: percent, diffFile, issues };
};

tourButton.addEventListener("click", async () => {
  tourButton.disabled = true;
  try {
    await capture();
    const run = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const shots: Shot[] = [];
    say("Starting from the top…");
    (await player()).restart();
    await sleep(1500);
    await player();
    await sleep(2500);
    for (const [index, title] of script.chapters.map((c) => c.title).entries()) {
      say(`Step ${index + 1} of ${script.chapters.length}: ${title}…`);
      if (index > 0) {
        (await player()).goTo(index);
        await settled();
        await sleep(400);
      }
      shots.push(await shoot(run, `${String(index + 1).padStart(2, "0")}-${slug(title)}`, "step", title));
    }
    for (const [index, path] of (script.paths ?? []).entries()) {
      say(`Error ${index + 1} of ${script.paths!.length}: ${path.label}…`);
      (await player()).showPath(path.id);
      await sleep(1500);
      await settled();
      shots.push(await shoot(run, `error-${path.id}`, "error", path.label));
    }
    const manifest = JSON.stringify(
      { run, at: new Date().toISOString(), viewport: frame.style.width || "fit", shots },
      null,
      2
    );
    await save(`shots/${run}/manifest.json`, manifest);
    await save("shots/latest/manifest.json", manifest);
    const changed = shots.filter((shot) => (shot.diff ?? 0) >= 5).length;
    const flagged = shots.reduce((sum, shot) => sum + shot.issues.length, 0);
    say(
      `${shots.length} screens saved · ${changed} changed since last time · ${flagged} things to check · <a href="/__prototype/sheet" target="_blank">Open the contact sheet</a>`
    );
  } catch (error) {
    say(`Stopped: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    tourButton.disabled = false;
  }
});

// Recording: the frame drawn onto a canvas, recorded as it plays.
let recorder: MediaRecorder | null = null;
recordButton.addEventListener("click", async () => {
  if (recorder) return recorder.stop();
  try {
    await capture();
    const canvas = document.createElement("canvas");
    draw(canvas);
    let drawing = true;
    const loop = () => {
      if (!drawing) return;
      draw(canvas);
      requestAnimationFrame(loop);
    };
    loop();
    const type = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm"].find((t) =>
      MediaRecorder.isTypeSupported(t)
    )!;
    const chunks: Blob[] = [];
    recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: type });
    recorder.addEventListener("dataavailable", (event) => chunks.push(event.data));
    recorder.addEventListener("stop", async () => {
      drawing = false;
      recorder = null;
      recordButton.textContent = "● Record";
      recordButton.classList.remove("recording");
      const file = `recordings/${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.${type.startsWith("video/mp4") ? "mp4" : "webm"}`;
      await save(file, new Blob(chunks, { type }));
      say(`Saved <a href="/__prototype/file?path=${encodeURIComponent(file)}" target="_blank">.prototype/${file}</a>`);
    });
    recorder.start(1000);
    recordButton.textContent = "■ Stop recording";
    recordButton.classList.add("recording");
    say("Recording. Play the flow in the frame, then stop.");
    (await player()).play();
  } catch (error) {
    say(`Couldn't record: ${error instanceof Error ? error.message : String(error)}`);
  }
});
