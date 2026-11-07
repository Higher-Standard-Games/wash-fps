import "../../../../style.css";
import "../../../../engine/ui/styles/WashikiFonts.css";
import "../styles/LobbyWelcomeDialog.css";
import "./ExportVideo.css";
import { background } from "../../../../engine/core/AsyncErrors";
import { DemoReader } from "../../../../shared/demo/DemoReader";
import { downloadDemo } from "../DemoDownload";
import { REEL_MINUTES, type ReelMinutes, reelLengths } from "../ReelLengths";
import { loadExportMusicChoices } from "./ExportMusic";
import { type ExportMusicSelection, parseSongStart } from "./ExportMusicSelection";
import { renderDemoMovie } from "./ExportRenderer";
import { type ExportSource, isExportSource } from "./ExportSource";
import type { TemporaryVideo } from "./TemporaryVideo";

document.body.innerHTML = `<div class="video-export-shell lobby-guide"><main class="video-export-page lobby-guide__card">
  <header class="lobby-guide__header">
    <span class="lobby-guide__eyebrow">YOUR MATCH. YOUR HIGHLIGHTS.</span>
    <h1>Export highlights</h1>
    <p class="source">Choose a recording</p>
  </header>
  <p class="video-export-format">1080p · 60 FPS · MP4 · stereo game audio</p>
  <input type="file" accept=".shagdemo" aria-label="Choose a demo">
  <div class="video-export-settings">
    <fieldset><legend>Highlight length</legend><div class="lengths"></div></fieldset>
    <div class="video-export-music">
      <label class="video-export-label" for="video-export-music">Background music</label>
      <select id="video-export-music" disabled><option value="">&lt;none&gt;</option></select>
      <div class="video-export-song-start">
        <label class="video-export-label" for="video-export-song-start">Start from</label>
        <input id="video-export-song-start" type="text" value="0:00" placeholder="m:ss" aria-describedby="video-export-music-help" disabled>
      </div>
      <p id="video-export-music-help" class="video-export-help">Loading OST song list…</p>
    </div>
  </div>
  <div class="video-export-actions"><button class="generate lobby-guide__button" disabled>Generate video</button>
  <button class="cancel lobby-guide__button" disabled>Cancel</button>
  <button class="download lobby-guide__button" disabled>Download</button>
  <button class="discard lobby-guide__button" disabled>Discard video</button></div>
  <p class="status video-export-status" role="status" aria-live="polite">Waiting for a demo</p>
  <progress max="600" value="0" aria-label="Encoded frames"></progress>
  <p class="video-export-help">Keep this window visible while generating. Download saves your finished video.</p>
  <canvas class="movie-preview" width="1280" height="720"></canvas>
</main></div>`;
const canvas = document.querySelector<HTMLCanvasElement>(".movie-preview")!;
const status = document.querySelector<HTMLElement>(".status")!;
const progress = document.querySelector<HTMLProgressElement>("progress")!;
const generate = document.querySelector<HTMLButtonElement>(".generate")!;
const cancel = document.querySelector<HTMLButtonElement>(".cancel")!;
const download = document.querySelector<HTMLButtonElement>(".download")!;
const discard = document.querySelector<HTMLButtonElement>(".discard")!;
const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
const musicSelect = document.querySelector<HTMLSelectElement>("#video-export-music")!;
const songStart = document.querySelector<HTMLInputElement>("#video-export-song-start")!;
const musicHelp = document.querySelector<HTMLElement>("#video-export-music-help")!;
const catalogue = new AbortController();
let musicReady = false;
const sourceLabel = document.querySelector<HTMLElement>(".source")!;
const lengths = document.querySelector<HTMLElement>(".lengths")!;
let source: ExportSource | null = null;
let sourceReadId = 0;
let selected: ReelMinutes = 1;
const choices = REEL_MINUTES.map((minutes) => {
  const label = document.createElement("label");
  label.className = "video-export-length";
  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = "length";
  radio.value = String(minutes);
  radio.addEventListener("change", () => {
    if (radio.checked) selected = minutes;
  });
  const face = document.createElement("span");
  const number = document.createElement("b");
  number.textContent = String(minutes);
  const unit = document.createElement("small");
  unit.textContent = "min";
  face.append(number, unit);
  label.append(radio, face);
  lengths.append(label);
  return radio;
});
let controller: AbortController | null = null;
let saveController: AbortController | null = null;
let result: TemporaryVideo | null = null;
let saved = false;
let saving = false;
let port: MessagePort | null = null;
const jobId = new URLSearchParams(location.search).get("job");

function sync() {
  const allowed = reelLengths(source?.durationMs ?? 0);
  if (!allowed.includes(selected)) selected = allowed[0] ?? 1;
  for (const radio of choices) {
    radio.checked = Number(radio.value) === selected;
    radio.disabled = !allowed.includes(Number(radio.value) as ReelMinutes) || !!controller || !!result || saving;
  }
  generate.disabled = !allowed.length || !!controller || !!result || saving;
  input.disabled = !!controller || !!result || saving;
  musicSelect.disabled = !musicReady || !!controller || !!result || saving;
  songStart.disabled = !musicSelect.value || !!controller || !!result || saving;
  cancel.disabled = !controller && !saveController;
  download.disabled = !result || saving;
  discard.disabled = !result || saving;
  port?.postMessage({ type: "state", canClose: !controller && !saving && (!result || saved) });
}

/** Development harness: the UI and browser acceptance use the same job path. */
export const exportSession = {
  async run(
    recording: Uint8Array | ExportSource,
    options: { fromSeconds?: number; stallMs?: number; reelMinutes?: ReelMinutes; music?: ExportMusicSelection } = {},
  ) {
    if (controller || result) throw new Error("Finish or discard the current export first");
    controller = new AbortController();
    const frozenOptions = { ...options, music: options.music ? { ...options.music } : undefined };
    saved = false;
    progress.value = 0;
    let lastProgress = -Infinity;
    let lastPhase = "";
    sync();
    try {
      status.textContent = "Reading recording";
      const bytes =
        recording instanceof Uint8Array
          ? recording
          : (recording.bytes ?? (await downloadDemo(recording.url!, controller.signal)));
      controller.signal.throwIfAborted();
      if (frozenOptions.reelMinutes) {
        const reader = await DemoReader.fromFile(bytes);
        if (!reelLengths(reader.readIndex().durationMs).includes(frozenOptions.reelMinutes))
          throw new Error("This recording is too short for the selected highlight length");
      }
      result = await renderDemoMovie(bytes, canvas, {
        ...frozenOptions,
        signal: controller.signal,
        progress: (phase, frames, total) => {
          const now = performance.now();
          if (phase === lastPhase && now - lastProgress < 100 && frames !== total) return;
          lastProgress = now;
          lastPhase = phase;
          status.textContent =
            frames === undefined
              ? phase
              : total === undefined
                ? `${phase}: ${frames} frames`
                : `${phase}: ${frames} / ${total}`;
          if (total !== undefined) {
            progress.max = total;
            progress.value = frames ?? 0;
          } else progress.removeAttribute("value");
        },
      });
      const file = await result.file();
      progress.value = progress.max;
      status.textContent = `Video ready: ${(progress.max / 60).toFixed(1)} seconds, ${(file.size / 1024 / 1024).toFixed(1)} MB. Download saves the finalized MP4.`;
    } catch (error) {
      const failure = controller.signal.aborted ? controller.signal.reason : error;
      status.textContent =
        failure instanceof DOMException && failure.name === "AbortError"
          ? "Export cancelled"
          : `Export failed: ${String(failure)}`;
      throw error;
    } finally {
      controller = null;
      sync();
    }
  },
  async file() {
    if (!result) throw new Error("No finished video");
    return result.file();
  },
  async discard() {
    if (controller || saving) throw new Error("The export is busy");
    try {
      await result?.dispose();
    } catch (error) {
      status.textContent = `Could not discard the video. Download or try Discard again: ${String(error)}`;
      sync();
      throw error;
    }
    result = null;
    saved = false;
    progress.value = 0;
    status.textContent = "Ready";
    sync();
  },
  cancel() {
    controller?.abort(new DOMException("Export cancelled", "AbortError"));
    saveController?.abort(new DOMException("Save cancelled", "AbortError"));
  },
};

input.addEventListener("change", () => {
  const readId = ++sourceReadId;
  const file = input.files?.[0];
  if (!file) return;
  source = null;
  status.textContent = "Reading recording";
  sync();
  background(
    (async () => {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const reader = await DemoReader.fromFile(bytes);
        if (readId !== sourceReadId) return;
        source = { bytes, label: file.name, filename: file.name, durationMs: reader.readIndex().durationMs };
        sourceLabel.textContent = source.label;
        status.textContent = reelLengths(source.durationMs).length
          ? "Ready to generate"
          : "A highlight reel needs at least three minutes of recording";
      } catch (error) {
        if (readId !== sourceReadId) return;
        status.textContent = `Could not open recording: ${String(error)}`;
      }
      sync();
    })(),
    "Opening export demo",
  );
});
generate.addEventListener("click", () => {
  let music: ExportMusicSelection | undefined;
  if (musicSelect.value) {
    try {
      music = { path: musicSelect.value, startSeconds: parseSongStart(songStart.value) };
    } catch (error) {
      songStart.setCustomValidity(error instanceof Error ? error.message : "Choose a valid song timestamp.");
      songStart.reportValidity();
      return;
    }
  }
  if (source)
    background(
      exportSession.run(source, { reelMinutes: selected, music }).catch((error) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
      }),
      "Video export",
    );
});
songStart.addEventListener("input", () => songStart.setCustomValidity(""));
musicSelect.addEventListener("change", () => {
  songStart.setCustomValidity("");
  musicHelp.textContent = musicSelect.value
    ? "Timestamp in the song. Music plays continuously at normal speed."
    : "Game audio only. Choose a song to add the OST.";
  sync();
});
background(
  loadExportMusicChoices(catalogue.signal)
    .then((choices) => {
      for (const choice of choices) {
        const option = document.createElement("option");
        option.value = choice.path;
        option.textContent = choice.title;
        musicSelect.append(option);
      }
      musicReady = true;
      musicHelp.textContent = choices.length
        ? "Optional OST. Game audio is always included."
        : "No OST songs found. Game audio is available.";
      sync();
    })
    .catch((error) => {
      if (!catalogue.signal.aborted)
        musicHelp.textContent = `OST list unavailable. Game audio is available. ${String(error)}`;
    }),
  "Loading export OST choices",
);
cancel.addEventListener("click", () => exportSession.cancel());
discard.addEventListener("click", () => background(exportSession.discard(), "Discarding video"));
download.addEventListener("click", () => {
  if (!result || saving) return;
  const picker = (
    window as Window & {
      showSaveFilePicker?: (options: object) => Promise<FileSystemFileHandle>;
    }
  ).showSaveFilePicker;
  // Acquire the picker promise during this click, before any asynchronous file work.
  const filename = `${(source?.filename ?? "washoi").replace(/\.shagdemo$/i, "").replace(/[^a-zA-Z0-9_-]/g, "-")}-highlights.mp4`;
  let destination: Promise<FileSystemFileHandle> | undefined;
  try {
    destination = picker?.({
      suggestedName: filename,
      types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }],
    });
  } catch (error) {
    status.textContent = `Could not open save picker: ${String(error)}`;
    return;
  }
  saving = true;
  saveController = new AbortController();
  const saveSignal = saveController.signal;
  sync();
  background(
    (async () => {
      try {
        const handle = destination ? await destination : null;
        saveSignal.throwIfAborted();
        const file = await exportSession.file();
        if (handle) {
          const writable = await handle.createWritable();
          await file.stream().pipeTo(writable, { signal: saveSignal });
          saved = true;
          status.textContent = "Saved video";
        } else {
          if (file.size > 64 * 1024 * 1024)
            throw new Error("This browser requires a file picker for videos larger than 64 MB");
          const url = URL.createObjectURL(file);
          const link = document.createElement("a");
          link.href = url;
          link.download = filename;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
          saved = true;
          status.textContent = "Download started";
        }
      } catch (error) {
        status.textContent =
          error instanceof DOMException && error.name === "AbortError"
            ? "Save cancelled. The video is still ready."
            : `Save failed. The video is still ready: ${String(error)}`;
      } finally {
        saving = false;
        saveController = null;
        sync();
      }
    })(),
    "Saving exported video",
  );
});

window.addEventListener("beforeunload", (event) => {
  if (controller || saving || (result && !saved)) {
    event.preventDefault();
    event.returnValue = "";
  }
});
window.addEventListener("pagehide", () => {
  sourceReadId++;
  catalogue.abort();
  exportSession.cancel();
  if (result) background(result.dispose(), "Releasing temporary video");
  port?.close();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && controller)
    controller.abort(new Error("The export window was hidden. Keep it visible and try again."));
});
function acceptDemo(event: MessageEvent) {
  if (
    event.source !== window.parent ||
    event.origin !== location.origin ||
    event.data?.type !== "videoexport:init" ||
    event.data.jobId !== jobId ||
    !event.ports[0] ||
    !isExportSource(event.data.source)
  )
    return;
  window.removeEventListener("message", acceptDemo);
  port = event.ports[0];
  const accepted: ExportSource = event.data.source;
  sourceReadId++;
  source = accepted;
  sourceLabel.textContent = accepted.label;
  status.textContent = "Ready to generate highlight video";
  input.hidden = true;
  sync();
}
sync();
if (window.parent !== window && jobId) {
  window.addEventListener("message", acceptDemo);
  window.parent.postMessage({ type: "videoexport:ready", jobId }, location.origin);
}
