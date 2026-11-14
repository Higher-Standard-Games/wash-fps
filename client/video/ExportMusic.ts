import { AudioManager } from "../../../../engine/AudioManager";
import { PK3Index } from "../../../../engine/loader/pk3/PK3Index";
import type { MatchMusic } from "./ExportAudioMixer";
import {
  type ExportMusicChoice,
  type ExportMusicSelection,
  matchMusicSchedule,
  musicPlaybackWindow,
  soundtrackTitle,
} from "./ExportMusicSelection";
import { abortable } from "./MovieClock";

const SOUNDTRACK_PACKAGE = "washoi_soundtrack.pk3";
const MAX_MUSIC_BYTES = 32 * 1024 * 1024;
const MAX_MUSIC_PCM_BYTES = 192 * 1024 * 1024;
/** The songs a match plays, shuffled. */
const GAME_PLAYLIST = "data/game.playlist.json";

export interface PreparedExportMusic {
  buffer: AudioBuffer;
  startSeconds: number;
}

/** Enumerate the OST package rather than limiting the selector to the gameplay playlist. */
export async function loadExportMusicChoices(signal: AbortSignal): Promise<ExportMusicChoice[]> {
  const index = PK3Index.getInstance();
  await abortable(index.ensureIndex(), signal);
  signal.throwIfAborted();
  return index
    .findByPattern("*.mp3")
    .filter(({ pk3 }) => pk3.toLowerCase() === SOUNDTRACK_PACKAGE)
    .map(({ file }) => ({ path: file, title: soundtrackTitle(file) }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** Decode one OST song, within the music budgets. */
async function decodeSong(path: string, signal: AbortSignal): Promise<AudioBuffer> {
  if (PK3Index.getInstance().findFile(path)?.toLowerCase() !== SOUNDTRACK_PACKAGE)
    throw new Error("The selected song is not in the OST package.");
  const bytes = await abortable(AudioManager.getInstance().readSfxBytes(path), signal);
  if (bytes.byteLength > MAX_MUSIC_BYTES) throw new Error("The selected song exceeds the music-file budget.");
  const decoder = new OfflineAudioContext(2, 1, 48000);
  const buffer = await abortable(decoder.decodeAudioData(bytes.slice(0)), signal);
  if (buffer.length * buffer.numberOfChannels * 4 > MAX_MUSIC_PCM_BYTES)
    throw new Error("The selected song exceeds the decoded-music budget.");
  return buffer;
}

/** Decode only the selected OST track; the default None path never loads music PCM. */
export async function prepareExportMusic(
  selection: ExportMusicSelection,
  signal: AbortSignal,
): Promise<PreparedExportMusic> {
  if (!Number.isFinite(selection.startSeconds) || selection.startSeconds < 0)
    throw new Error("The song start must be a nonnegative timestamp.");
  const buffer = await decodeSong(selection.path, signal);
  musicPlaybackWindow(buffer.duration, selection.startSeconds, 1);
  return { buffer, startSeconds: selection.startSeconds };
}

/**
 * A whole match's music: the selected song, then the game playlist's songs in
 * a shuffled turn until `movieSeconds`. Each song is decoded once here for its
 * length, and again by the mix only while it sounds.
 */
export async function prepareMatchMusic(
  selection: ExportMusicSelection,
  movieSeconds: number,
  signal: AbortSignal,
): Promise<MatchMusic> {
  if (!Number.isFinite(selection.startSeconds) || selection.startSeconds < 0)
    throw new Error("The song start must be a nonnegative timestamp.");
  const choices = await loadExportMusicChoices(signal);
  const response = await abortable(fetch(GAME_PLAYLIST, { signal }), signal);
  if (!response.ok) throw new Error(`The game playlist did not load (HTTP ${response.status}).`);
  const playlist = (await abortable(response.json(), signal)) as { tracks?: Array<{ file?: string }> };
  const base = (path: string) => path.replace(/^.*[/\\]/, "").toLowerCase();
  const paths = (playlist.tracks ?? [])
    .map((track) => choices.find((choice) => base(choice.path) === base(track.file ?? ""))?.path)
    .filter((path): path is string => !!path);
  const lengths = new Map<string, number>();
  for (const path of new Set([selection.path, ...paths])) {
    lengths.set(path, (await decodeSong(path, signal)).duration);
    signal.throwIfAborted();
  }
  const segments = matchMusicSchedule(
    { path: selection.path, startSeconds: selection.startSeconds, seconds: lengths.get(selection.path)! },
    paths.map((path) => ({ path, seconds: lengths.get(path)! })),
    movieSeconds,
  );
  return { segments, load: decodeSong };
}
