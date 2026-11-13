import "../../../../style.css";
import "../../../../engine/ui/styles/WashikiFonts.css";
import "../styles/LobbyWelcomeDialog.css";
import "./ExportVideo.css";
import { background } from "../../../../engine/core/AsyncErrors";
import { raiseKey } from "../../../../engine/ui/components/RaisedKey";
import { DemoReader } from "../../../../shared/demo/DemoReader";
import { toClientKey } from "../../ClientEntityKey";
import { downloadDemo } from "../DemoDownload";
import { REEL_MINUTES, type ReelMinutes, reelLengths } from "../ReelLengths";
import { loadExportMusicChoices } from "./ExportMusic";
import { type ExportMusicSelection, parseSongStart } from "./ExportMusicSelection";
import { renderDemoMovie } from "./ExportRenderer";
import { type ExportSource, isExportSource } from "./ExportSource";
import { MATCH_MAX_SECONDS } from "./MovieClock";
import type { TemporaryVideo } from "./TemporaryVideo";

type VideoKind = "reel" | "match";
/** Who a full-match video can follow: the recording's roster. */
interface RosterEntry {
  key: string;
  name: string;
}

const MATCH_MIN_MS = 10_000;

document.body.innerHTML = `<div class="video-export-shell lobby-guide"><main class="video-export-page lobby-guide__card">
  <header class="lobby-guide__header">
    <span class="lobby-guide__eyebrow">YOUR MATCH. YOUR HIGHLIGHTS.</span>
    <h1>Export highlights</h1>
    <p class="source">Choose a recording</p>
  </header>
  <p class="video-export-format">1080p · 60 FPS · MP4 · stereo game audio</p>
  <input type="file" accept=".shagdemo" aria-label="Choose a demo">
  <details class="video-export-advanced">
    <summary>Advanced</summary>
    <div class="video-export-advanced__body">
      <div class="video-export-field">
        <label class="video-export-label" for="video-export-kind">Video</label>
        <select id="video-export-kind">
          <option value="reel">Highlight reel</option>
          <option value="match">Full match with game HUD</option>
        </select>
      </div>
      <div class="video-export-field">
        <label class="video-export-label" for="video-export-follow">Follow player</label>
        <select id="video-export-follow" disabled><option value="">Choose a recording first</option></select>
      </div>
      <p class="video-export-help video-export-kind-help">A highlight reel of the match's best moments, with cinematic cameras.</p>
    </div>
  </details>
  <div class="video-export-settings">
    <fieldset class="video-export-lengths"><legend>Highlight length</legend><div class="lengths"></div></fieldset>
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
for (const key of [generate, cancel, download, discard]) {
  raiseKey(key, { label: key.textContent ?? "", variants: ["ink", "inline"] });
}
const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
const musicSelect = document.querySelector<HTMLSelectElement>("#video-export-music")!;
const songStart = document.querySelector<HTMLInputElement>("#video-export-song-start")!;
const musicHelp = document.querySelector<HTMLElement>("#video-export-music-help")!;
const catalogue = new AbortController();
let musicReady = false;
const sourceLabel = document.querySelector<HTMLElement>(".source")!;
const lengths = document.querySelector<HTMLElement>(".lengths")!;
const title = document.querySelector<HTMLElement>("h1")!;
const format = document.querySelector<HTMLElement>(".video-export-format")!;
const kindSelect = document.querySelector<HTMLSelectElement>("#video-export-kind")!;
const followSelect = document.querySelector<HTMLSelectElement>("#video-export-follow")!;
const kindHelp = document.querySelector<HTMLElement>(".video-export-kind-help")!;
const musicBlock = document.querySelector<HTMLElement>(".video-export-music")!;
const lengthsBlock = document.querySelector<HTMLElement>(".video-export-lengths")!;
let source: ExportSource | null = null;
let sourceReadId = 0;
let selected: ReelMinutes = 1;
let kind: VideoKind = "reel";
/** The open recording's players; null until its header has been read. */
let roster: RosterEntry[] | null = null;
let rosterLoading = false;
let rosterController: AbortController | null = null;
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
/** What the finished video is, for its file name: `highlights`, or `<player>-match`. */
let resultName = "highlights";
let port: MessagePort | null = null;
const jobId = new URLSearchParams(location.search).get("job");

/** Why the open recording cannot make a full-match video, or null if it can. */
function matchUnavailable(durationMs: number): string | null {
  if (durationMs < MATCH_MIN_MS) return "A full-match video needs at least ten seconds of recording";
  if (durationMs > MATCH_MAX_SECONDS * 1000)
    return `Full-match videos are limited to ${MATCH_MAX_SECONDS / 60} minutes of recording`;
  return null;
}

function sync() {
  const busy = !!controller || !!result || saving;
  const match = kind === "match";
  const allowed = reelLengths(source?.durationMs ?? 0);
  if (!allowed.includes(selected)) selected = allowed[0] ?? 1;
  for (const radio of choices) {
    radio.checked = Number(radio.value) === selected;
    radio.disabled = match || !allowed.includes(Number(radio.value) as ReelMinutes) || busy;
  }
  const matchReady = !!source && !matchUnavailable(source.durationMs) && !!followSelect.value;
  generate.disabled = (match ? !matchReady : !allowed.length) || busy || rosterLoading;
  input.disabled = busy;
  kindSelect.disabled = busy;
  followSelect.disabled = !match || !roster?.length || busy;
  lengthsBlock.hidden = match;
  musicBlock.hidden = match;
  title.textContent = match ? "Export full match" : "Export highlights";
  format.textContent = match
    ? "1080p · 60 FPS · MP4 · stereo game audio · game HUD"
    : "1080p · 60 FPS · MP4 · stereo game audio";
  musicSelect.disabled = !musicReady || busy;
  songStart.disabled = !musicSelect.value || busy;
  cancel.disabled = !controller && !saveController;
  download.disabled = !result || saving;
  discard.disabled = !result || saving;
  port?.postMessage({ type: "state", canClose: !controller && !saving && (!result || saved) });
}

/** Shared job path for the export UI and browser acceptance checks. */
export const exportSession = {
  async run(
    recording: Uint8Array | ExportSource,
    options: {
      fromSeconds?: number;
      stallMs?: number;
      reelMinutes?: ReelMinutes;
      music?: ExportMusicSelection;
      match?: { follow: string };
    } = {},
  ) {
    if (controller || result) throw new Error("Finish or discard the current export first");
    controller = new AbortController();
    const frozenOptions = {
      ...options,
      music: options.music ? { ...options.music } : undefined,
      match: options.match ? { ...options.match } : undefined,
    };
    saved = false;
    kind = frozenOptions.match ? "match" : "reel";
    kindSelect.value = kind;
    const followed = frozenOptions.match && roster?.find((entry) => entry.key === frozenOptions.match!.follow);
    resultName = frozenOptions.match ? `${followed?.name ?? "player"}-match` : "highlights";
    progress.value = 0;
    let lastProgress = -Infinity;
    let lastPhase = "";
    let movieFrames = 0;
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
      if (frozenOptions.match) {
        const reader = await DemoReader.fromFile(bytes);
        const unavailable = matchUnavailable(reader.readIndex().durationMs);
        if (unavailable) throw new Error(unavailable);
      }
      result = await renderDemoMovie(bytes, canvas, {
        ...frozenOptions,
        signal: controller.signal,
        progress: (phase, frames, total) => {
          const now = performance.now();
          if (phase === lastPhase && now - lastProgress < 100 && frames !== total) return;
          lastProgress = now;
          lastPhase = phase;
          if (total !== undefined && (phase.startsWith("Rendering") || phase.startsWith("Recording")))
            movieFrames = total;
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
      const seconds = movieFrames / 60;
      const whole = Math.round(seconds);
      const length =
        whole >= 60
          ? `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`
          : `${seconds.toFixed(1)} seconds`;
      status.textContent = `Video ready: ${length}, ${(file.size / 1024 / 1024).toFixed(1)} MB. Download saves the finalized MP4.`;
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

/** What the open recording can make with the current choices. */
function readyText(): string {
  if (!source) return "Waiting for a demo";
  if (kind === "match") {
    const unavailable = matchUnavailable(source.durationMs);
    if (unavailable) return unavailable;
    if (rosterLoading) return "Reading the players";
    if (!roster?.length) return "This recording names no players to follow";
    return "Ready to generate the full match";
  }
  return reelLengths(source.durationMs).length
    ? "Ready to generate highlight video"
    : "A highlight reel needs at least three minutes of recording";
}

function readRoster(reader: DemoReader): RosterEntry[] {
  const seen = new Set<string>();
  const entries: RosterEntry[] = [];
  for (const player of reader.readHeader().players) {
    const key = toClientKey(player.playerId);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ key, name: player.name || key });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function showRoster(): void {
  const previous = followSelect.value;
  followSelect.replaceChildren();
  if (!roster?.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = rosterLoading ? "Reading players…" : source ? "No players" : "Choose a recording first";
    followSelect.append(option);
    return;
  }
  for (const entry of roster) {
    const option = document.createElement("option");
    option.value = entry.key;
    option.textContent = entry.name;
    followSelect.append(option);
  }
  if (roster.some((entry) => entry.key === previous)) followSelect.value = previous;
}

/** A recording from the server is fetched when its roster is first needed, once. */
function ensureRoster(): void {
  if (roster || rosterLoading || !source) return;
  const current = source;
  const readId = sourceReadId;
  rosterLoading = true;
  rosterController = new AbortController();
  const signal = rosterController.signal;
  showRoster();
  status.textContent = readyText();
  sync();
  background(
    (async () => {
      try {
        const bytes = current.bytes ?? (await downloadDemo(current.url!, signal));
        const reader = await DemoReader.fromFile(bytes);
        if (readId !== sourceReadId || source !== current) return;
        current.bytes = bytes;
        roster = readRoster(reader);
      } catch (error) {
        if (readId !== sourceReadId || signal.aborted) return;
        roster = [];
        status.textContent = `Could not read the players: ${String(error)}`;
      } finally {
        if (readId === sourceReadId) {
          rosterLoading = false;
          rosterController = null;
          showRoster();
          if (roster?.length) status.textContent = readyText();
          sync();
        }
      }
    })(),
    "Reading export roster",
  );
}

function resetRoster(): void {
  rosterController?.abort(new DOMException("Recording replaced", "AbortError"));
  rosterController = null;
  rosterLoading = false;
  roster = null;
  showRoster();
}

input.addEventListener("change", () => {
  const readId = ++sourceReadId;
  const file = input.files?.[0];
  if (!file) return;
  source = null;
  resetRoster();
  status.textContent = "Reading recording";
  sync();
  background(
    (async () => {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const reader = await DemoReader.fromFile(bytes);
        if (readId !== sourceReadId) return;
        source = { bytes, label: file.name, filename: file.name, durationMs: reader.readIndex().durationMs };
        roster = readRoster(reader);
        showRoster();
        sourceLabel.textContent = source.label;
        status.textContent = readyText();
      } catch (error) {
        if (readId !== sourceReadId) return;
        status.textContent = `Could not open recording: ${String(error)}`;
      }
      sync();
    })(),
    "Opening export demo",
  );
});
kindSelect.addEventListener("change", () => {
  kind = kindSelect.value === "match" ? "match" : "reel";
  kindHelp.textContent =
    kind === "match"
      ? "The whole match through one player's eyes, with their game HUD, as they played it. Takes a few times the match's length to make."
      : "A highlight reel of the match's best moments, with cinematic cameras.";
  if (kind === "match") ensureRoster();
  status.textContent = readyText();
  sync();
});
followSelect.addEventListener("change", () => sync());
generate.addEventListener("click", () => {
  if (kind === "match") {
    if (source && followSelect.value)
      background(
        exportSession.run(source, { match: { follow: followSelect.value } }).catch((error) => {
          if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
        }),
        "Video export",
      );
    return;
  }
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
  const filename = `${`${(source?.filename ?? "washoi").replace(/\.shagdemo$/i, "")}-${resultName}`.replace(/[^a-zA-Z0-9_-]/g, "-")}.mp4`;
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
  rosterController?.abort();
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
  resetRoster();
  source = accepted;
  sourceLabel.textContent = accepted.label;
  input.hidden = true;
  if (kind === "match") ensureRoster();
  status.textContent = readyText();
  sync();
}
sync();
if (window.parent !== window && jobId) {
  window.addEventListener("message", acceptDemo);
  window.parent.postMessage({ type: "videoexport:ready", jobId }, location.origin);
}
