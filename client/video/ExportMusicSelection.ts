export interface ExportMusicSelection {
  path: string;
  startSeconds: number;
}

export interface ExportMusicChoice {
  path: string;
  title: string;
}

/** Accept seconds, m:ss or h:mm:ss, with up to millisecond precision. */
export function parseSongStart(value: string): number {
  const text = value.trim();
  if (!/^\d+(?:\.\d{1,3})?$/.test(text) && !/^\d+(?::[0-5]\d){1,2}(?:\.\d{1,3})?$/.test(text))
    throw new Error("Use seconds, m:ss or h:mm:ss for the song start.");
  const seconds = text.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > Number.MAX_SAFE_INTEGER / 48000)
    throw new Error("The song start is out of range.");
  return seconds;
}

export function soundtrackTitle(path: string): string {
  return path
    .replace(/^.*[/\\]/, "")
    .replace(/\.[^.]+$/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Music uses movie time, so source slow motion never changes its tempo. */
export function musicPlaybackWindow(songSeconds: number, startSeconds: number, movieSeconds: number) {
  if (
    ![songSeconds, startSeconds, movieSeconds].every(Number.isFinite) ||
    songSeconds <= 0 ||
    startSeconds < 0 ||
    startSeconds >= songSeconds ||
    movieSeconds <= 0
  )
    throw new Error("Choose a start timestamp before the end of the selected song.");
  const duration = Math.min(movieSeconds, songSeconds - startSeconds);
  return { offset: startSeconds, duration, fadeIn: Math.min(0.25, duration / 2), fadeOut: Math.min(1.5, duration / 2) };
}
