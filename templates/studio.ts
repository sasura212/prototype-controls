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

const frame = document.querySelector<HTMLIFrameElement>("iframe")!;
const status = document.querySelector<HTMLElement>("#status")!;
const recordButton = document.querySelector<HTMLButtonElement>("#record")!;
const recordLabel = document.querySelector<HTMLElement>(".recordLabel")!;
const tourButton = document.querySelector<HTMLButtonElement>("#tour")!;
const progress = document.querySelector<HTMLElement>(".progress")!;
const device = document.querySelector<HTMLElement>(".device")!;
const viewport = document.querySelector<HTMLElement>(".viewport")!;
const badge = document.querySelector<HTMLElement>(".badge")!;
const preset = document.querySelector<HTMLSelectElement>("#preset")!;
const widthField = document.querySelector<HTMLInputElement>("#width")!;
const heightField = document.querySelector<HTMLInputElement>("#height")!;
frame.src = script.start;

const say = (html: string) => (status.innerHTML = html);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const save = (relative: string, data: BodyInit) =>
  fetch(`/__prototype/file?path=${encodeURIComponent(relative)}`, { method: "POST", body: data });

// ------------------------------------------------------------------------------------------------
// The frame's size: fit to the window, a device from the list, typed in, or dragged by its edges.
// Remembered between visits.
// ------------------------------------------------------------------------------------------------
type Size = { width: number; height: number } | null;
const SIZE_KEY = "prototype-studio-size";
const stage = () => viewport.parentElement!.getBoundingClientRect();
/** How much a device bigger than the window is scaled down to fit (1 when it fits). */
let zoom = 1;
let size: Size = null;
try {
  size = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "null");
} catch {
  // Storage blocked: start fitted to the window.
}
const applySize = () => {
  const room = stage();
  if (size) {
    zoom = Math.min(1, (room.width - 64) / size.width, (room.height - 64) / size.height);
    Object.assign(viewport.style, { width: `${size.width * zoom}px`, height: `${size.height * zoom}px` });
    Object.assign(device.style, {
      width: `${size.width}px`,
      height: `${size.height}px`,
      transform: zoom < 1 ? `scale(${zoom})` : "",
    });
  } else {
    zoom = 1;
    Object.assign(viewport.style, { width: "100%", height: "100%" });
    Object.assign(device.style, { width: "100%", height: "100%", transform: "" });
  }
  const shown = size ?? { width: Math.round(room.width - 48), height: Math.round(room.height - 48) };
  if (document.activeElement !== widthField) widthField.value = String(Math.round(shown.width));
  if (document.activeElement !== heightField) heightField.value = String(Math.round(shown.height));
  badge.textContent = `${Math.round(shown.width)} × ${Math.round(shown.height)}${zoom < 1 ? ` · ${Math.round(zoom * 100)}%` : ""}`;
  device.classList.toggle("zoomed", zoom < 1);
  const match = size ? `${size.width}x${size.height}` : "fit";
  preset.value = [...preset.options].some((o) => o.value === match) ? match : "custom";
};
const setSize = (next: Size) => {
  size = next && { width: Math.max(240, Math.round(next.width)), height: Math.max(240, Math.round(next.height)) };
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify(size));
  } catch {
    // Storage blocked: the size lasts until the page reloads.
  }
  applySize();
};
preset.addEventListener("change", () => {
  if (preset.value === "fit") return setSize(null);
  if (preset.value === "custom") return;
  const [width, height] = preset.value.split("x").map(Number);
  setSize({ width, height });
});
const typed = () => {
  const width = Number(widthField.value);
  const height = Number(heightField.value);
  if (width > 0 && height > 0) setSize({ width, height });
};
for (const field of [widthField, heightField]) {
  field.addEventListener("change", typed);
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") typed();
    // Arrow keys nudge by 1, or by 10 with Shift, like a design tool.
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const step = (event.shiftKey ? 10 : 1) * (event.key === "ArrowUp" ? 1 : -1);
      field.value = String(Number(field.value) + step);
      typed();
    }
  });
}
document.querySelector("#rotate")!.addEventListener("click", () => {
  const current = size ?? { width: Number(widthField.value), height: Number(heightField.value) };
  setSize({ width: current.height, height: current.width });
});
// Dragging an edge or the corner: the frame grows from its centre, so both sides move.
device.addEventListener("pointerdown", (event) => {
  const handle = (event.target as HTMLElement).closest<HTMLElement>("[data-resize]");
  if (!handle) return;
  const axis = handle.dataset.resize!;
  const start = {
    x: event.clientX,
    y: event.clientY,
    ...(size ?? { width: Number(widthField.value), height: Number(heightField.value) }),
  };
  try {
    handle.setPointerCapture(event.pointerId);
  } catch {
    // A synthetic pointer can't be captured; the drag still follows it.
  }
  device.classList.add("resizing");
  // Pointer movement is in screen pixels; a scaled-down device needs it in its own.
  const scale = zoom;
  const move = (e: PointerEvent) =>
    setSize({
      width: axis.includes("x") ? start.width + ((e.clientX - start.x) * 2) / scale : start.width,
      height: axis.includes("y") ? start.height + ((e.clientY - start.y) * 2) / scale : start.height,
    });
  const end = () => {
    device.classList.remove("resizing");
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", end);
    handle.removeEventListener("pointercancel", end);
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
});
// A focused handle moves with the arrow keys: 10px a press, 1px with Alt.
device.addEventListener("keydown", (event) => {
  const handle = (event.target as HTMLElement).closest<HTMLElement>("[data-resize]");
  if (!handle) return;
  const axis = handle.dataset.resize!;
  const step = event.altKey ? 1 : 10;
  const current = size ?? { width: Number(widthField.value), height: Number(heightField.value) };
  const deltas: Record<string, [number, number]> = {
    ArrowRight: [step, 0],
    ArrowLeft: [-step, 0],
    ArrowDown: [0, step],
    ArrowUp: [0, -step],
  };
  const delta = deltas[event.key];
  if (!delta) return;
  event.preventDefault();
  setSize({
    width: current.width + (axis.includes("x") ? delta[0] : 0),
    height: current.height + (axis.includes("y") ? delta[1] : 0),
  });
});
addEventListener("resize", applySize);
applySize();

/** The player in the frame, once its page has loaded (it reloads for replays and error paths). */
const player = async (): Promise<Player> => {
  for (let i = 0; i < 300; i++) {
    const found = (frame.contentWindow as (Window & { __prototype?: Player }) | null)?.__prototype;
    if (found && frame.contentDocument?.readyState === "complete") return found;
    await sleep(100);
  }
  throw new Error("The player didn't load in the frame");
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
// The screenshot tour: run by the player's server in a headless Chrome of its own, at the frame's
// size and 2× pixel density, so screenshots are sharp (the tab-capture stream is video, and blurs text).
type Tour = { running: boolean; done: number; total: number; label: string; error: string | null; run: string | null };
tourButton.addEventListener("click", async () => {
  tourButton.disabled = true;
  try {
    const width = Number(widthField.value);
    const height = Number(heightField.value);
    const started = await fetch("/__prototype/tour", {
      method: "POST",
      body: JSON.stringify({ width, height, scale: 2 }),
    });
    if (!started.ok && started.status !== 409) throw new Error(await started.text());
    say(`Taking screenshots at ${width} × ${height}… (in the background; the frame here is free to use)`);
    for (;;) {
      await sleep(600);
      const tour: Tour = await (await fetch("/__prototype/tour")).json();
      progress.style.width = tour.total ? `${(tour.done / tour.total) * 100}%` : "4%";
      if (tour.running) {
        say(`${escapeHtml(tour.label)}…`);
        continue;
      }
      if (tour.error) throw new Error(tour.error);
      say(`${escapeHtml(tour.label)} · <a href="/__prototype/sheet" target="_blank">Open the review</a>`);
      break;
    }
  } catch (error) {
    say(`Stopped: ${escapeHtml(error instanceof Error ? error.message : String(error))}`);
  } finally {
    tourButton.disabled = false;
    progress.style.width = "0";
  }
});
const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

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
    const began = Date.now();
    const clock = setInterval(() => {
      const seconds = Math.floor((Date.now() - began) / 1000);
      recordLabel.textContent = `Stop · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    }, 250);
    recorder.addEventListener("stop", async () => {
      drawing = false;
      recorder = null;
      clearInterval(clock);
      recordLabel.textContent = "Record";
      recordButton.classList.remove("recording");
      const file = `recordings/${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.${type.startsWith("video/mp4") ? "mp4" : "webm"}`;
      await save(file, new Blob(chunks, { type }));
      say(`Saved <a href="/__prototype/file?path=${encodeURIComponent(file)}" target="_blank">.prototype/${file}</a>`);
    });
    recorder.start(1000);
    recordLabel.textContent = "Stop · 0:00";
    recordButton.classList.add("recording");
    say("Recording. Play the flow in the frame, then stop.");
    (await player()).play();
  } catch (error) {
    say(`Couldn't record: ${error instanceof Error ? error.message : String(error)}`);
  }
});
