import { AudioManager } from "../../../../engine/AudioManager";
import { PK3Index } from "../../../../engine/loader/pk3/PK3Index";
import {
  type ExportMusicChoice,
  type ExportMusicSelection,
  musicPlaybackWindow,
  soundtrackTitle,
} from "./ExportMusicSelection";
import { abortable } from "./MovieClock";

const SOUNDTRACK_PACKAGE = "washoi_soundtrack.pk3";
const MAX_MUSIC_BYTES = 32 * 1024 * 1024;
const MAX_MUSIC_PCM_BYTES = 192 * 1024 * 1024;

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

/** Decode only the selected OST track; the default None path never loads music PCM. */
export async function prepareExportMusic(
  selection: ExportMusicSelection,
  signal: AbortSignal,
): Promise<PreparedExportMusic> {
  if (PK3Index.getInstance().findFile(selection.path)?.toLowerCase() !== SOUNDTRACK_PACKAGE)
    throw new Error("The selected song is not in the OST package.");
  if (!Number.isFinite(selection.startSeconds) || selection.startSeconds < 0)
    throw new Error("The song start must be a nonnegative timestamp.");
  const bytes = await abortable(AudioManager.getInstance().readSfxBytes(selection.path), signal);
  if (bytes.byteLength > MAX_MUSIC_BYTES) throw new Error("The selected song exceeds the music-file budget.");
  const decoder = new OfflineAudioContext(2, 1, 48000);
  const buffer = await abortable(decoder.decodeAudioData(bytes.slice(0)), signal);
  if (buffer.length * buffer.numberOfChannels * 4 > MAX_MUSIC_PCM_BYTES)
    throw new Error("The selected song exceeds the decoded-music budget.");
  musicPlaybackWindow(buffer.duration, selection.startSeconds, 1);
  return { buffer, startSeconds: selection.startSeconds };
}
