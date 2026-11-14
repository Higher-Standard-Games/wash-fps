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

/** One song's stretch of a movie's music, in movie seconds. */
export interface MusicSegment {
  path: string;
  /** Movie time the song comes in. */
  at: number;
  /** Song position it comes in at. */
  offset: number;
  duration: number;
}

/** Songs shorter than this never join a match's music: they would only repeat. */
const SHORTEST_SONG_SECONDS = 1;

/**
 * A whole match's music, played as a match plays its own: the chosen song from
 * the chosen position, then the game playlist shuffled once and played in turn,
 * round and round, with no gap between songs, until the movie ends. The chosen
 * song is left out of the playlist's turns unless it is the only song.
 */
export function matchMusicSchedule(
  first: { path: string; startSeconds: number; seconds: number },
  playlist: ReadonlyArray<{ path: string; seconds: number }>,
  movieSeconds: number,
  random: () => number = Math.random,
): MusicSegment[] {
  musicPlaybackWindow(first.seconds, first.startSeconds, movieSeconds);
  const segments: MusicSegment[] = [];
  let at = 0;
  const play = (path: string, offset: number, seconds: number) => {
    const duration = Math.min(seconds - offset, movieSeconds - at);
    segments.push({ path, at, offset, duration });
    at += duration;
  };
  play(first.path, first.startSeconds, first.seconds);
  const same = (path: string) => path.toLowerCase() === first.path.toLowerCase();
  const turns = playlist.filter((song) => !same(song.path) && song.seconds >= SHORTEST_SONG_SECONDS);
  if (turns.length === 0 && first.seconds >= SHORTEST_SONG_SECONDS) turns.push(first);
  for (let i = turns.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [turns[i], turns[j]] = [turns[j], turns[i]];
  }
  for (let i = 0; turns.length > 0 && movieSeconds - at > 1e-6; i++) {
    const song = turns[i % turns.length];
    play(song.path, 0, song.seconds);
  }
  return segments;
}
