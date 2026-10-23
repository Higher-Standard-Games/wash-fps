/**
 * A corpus of demos, so matches accumulate instead of evaporating.
 *
 * Behaviour cloning wants on the order of 10^5 frames and a three-minute duel
 * yields about 10k per player, so training from one file at a time was never
 * going to teach a bot to play like a person. This gathers every recording in a
 * directory, drops matches already counted, and splits a validation set off the
 * top.
 *
 * **The split is by match, not by frame.** Frames within one match are heavily
 * correlated — the same player, the same map, seconds apart — so a random frame
 * split leaks the answer into the validation set and reports a score that means
 * nothing. Whole matches go one way or the other.
 *
 * TF-10 in docs/research/BOT_TF_IMPROVEMENTS.md.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { TrainingFrame } from "./BotEpisodeRecorder";
import type { BotVision } from "./BotVision";
import { DemoTrainingExtractor, type ExtractOptions } from "./DemoTrainingExtractor";
import { typicalInterval } from "./ModelInputs";

export interface CorpusMatch {
  file: string;
  matchId?: string;
  map: string;
  players: number;
  frames: number;
  /** Ticks between one recorded frame and the next — the snapshot rate, measured. */
  frameInterval: number | null;
}

export interface CorpusSkip {
  file: string;
  reason: string;
}

/**
 * One player's frames from one match, in order.
 *
 * Runs are kept apart rather than concatenated because a label like "how far
 * did the view turn since the last frame" is only meaningful inside one. Flatten
 * two players together and every boundary produces a turn that nobody made.
 */
export type TrainingRun = TrainingFrame[];

export interface Corpus {
  train: TrainingRun[];
  validation: TrainingRun[];
  matches: CorpusMatch[];
  skipped: CorpusSkip[];
  /**
   * Maps whose geometry could not be loaded, so their matches were read without
   * line of sight or item distances. Still consistent with a bot on the same
   * blind terms, but it is the weaker kind of data and worth knowing about.
   */
  blindMaps: string[];
  get totalFrames(): number;
}

export interface CorpusOptions extends Omit<ExtractOptions, "vision"> {
  /** Share of frames held out for validation, by match. Default 0.2. */
  validationFraction?: number;
  /** Match ids already trained on, to skip. */
  seen?: ReadonlySet<string>;
  /**
   * Where a map's vision comes from. By default the map's BSP is loaded, once per
   * map, the same way the bot server does it. Tests pass their own, because a
   * scripted fixture's positions mean nothing inside a real map's walls.
   */
  visionFor?: (map: string) => Promise<BotVision | null>;
}

/** Load each map's vision at most once, and remember a map that would not load. */
function loadVisionOncePerMap(): (map: string) => Promise<BotVision | null> {
  const loaded = new Map<string, Promise<BotVision | null>>();
  return (map) => {
    let pending = loaded.get(map);
    if (!pending) {
      pending = import("./BotVision").then(({ createBotVision }) => createBotVision(map)).catch(() => null);
      loaded.set(map, pending);
    }
    return pending;
  };
}

/** Every `.shagdemo` in a directory, or the file itself if given one. */
export function listDemoFiles(target: string): string[] {
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return [target];
  return fs
    .readdirSync(target)
    .filter((name) => name.endsWith(".shagdemo"))
    .sort()
    .map((name) => path.join(target, name));
}

/**
 * Read every demo under `target` into one training corpus.
 *
 * A demo that cannot be read, or that yields no frames once bots are dropped,
 * is skipped with a reason rather than failing the run — one bad recording in a
 * directory of fifty should not cost the other forty-nine.
 */
export async function buildCorpus(target: string, options: CorpusOptions = {}): Promise<Corpus> {
  const files = listDemoFiles(target);
  const extractor = new DemoTrainingExtractor();
  const seen = new Set(options.seen ?? []);
  const visionFor = options.visionFor ?? loadVisionOncePerMap();

  const matches: CorpusMatch[] = [];
  const skipped: CorpusSkip[] = [];
  const blindMaps = new Set<string>();
  /** Per match, one run per player. */
  const perMatchRuns: TrainingRun[][] = [];

  for (const file of files) {
    try {
      const { header, frames } = DemoTrainingExtractor.decode(new Uint8Array(fs.readFileSync(file)));
      const matchId = header.matchId;

      // Before extracting, which is the expensive part
      if (matchId && seen.has(matchId)) {
        skipped.push({ file, reason: `already counted (match ${matchId})` });
        continue;
      }

      // The same map a bot on this server would load, so the frames are built
      // with the line of sight and item distances a bot would have had
      const vision = await visionFor(header.map);
      if (!vision) blindMaps.add(header.map);

      const dataset = extractor.extractDecoded(header, frames, { includeBots: options.includeBots, vision });
      if (dataset.totalFrames === 0) {
        skipped.push({
          file,
          reason: options.includeBots
            ? "no frames from any player — none of the roster was found alive in its snapshots"
            : "no frames from a verified player",
        });
        continue;
      }
      if (matchId) seen.add(matchId);

      matches.push({
        file,
        matchId,
        map: dataset.header.map,
        players: dataset.players.length,
        frames: dataset.totalFrames,
        frameInterval: typicalInterval(frames.map((frame) => frame.tick)),
      });
      perMatchRuns.push(dataset.players.map((player) => player.frames).filter((run) => run.length > 0));
    } catch (error) {
      skipped.push({ file, reason: (error as Error).message });
    }
  }

  const { train, validation } = splitByMatch(perMatchRuns, options.validationFraction ?? 0.2);
  const count = (runs: TrainingRun[]): number => runs.reduce((sum, run) => sum + run.length, 0);
  return {
    train,
    validation,
    matches,
    skipped,
    blindMaps: [...blindMaps],
    get totalFrames() {
      return count(train) + count(validation);
    },
  };
}

/**
 * Hold whole matches back for validation until the requested share of frames is
 * covered. With a single match there is nothing to hold back that would not
 * also empty the training set, so it all becomes training data and the caller
 * is told there is no validation.
 */
export function splitByMatch(
  perMatchRuns: readonly TrainingRun[][],
  validationFraction: number,
): { train: TrainingRun[]; validation: TrainingRun[] } {
  const sizeOf = (runs: readonly TrainingRun[]): number => runs.reduce((sum, run) => sum + run.length, 0);
  const total = perMatchRuns.reduce((sum, runs) => sum + sizeOf(runs), 0);
  const wanted = Math.floor(total * Math.max(0, Math.min(1, validationFraction)));

  if (perMatchRuns.length < 2 || wanted === 0) {
    return { train: perMatchRuns.flat(), validation: [] };
  }

  // Smallest matches first, so the held-out share overshoots as little as
  // possible and the training set keeps the biggest recordings.
  const order = perMatchRuns.map((runs, index) => ({ index, size: sizeOf(runs) })).sort((a, b) => a.size - b.size);

  const held = new Set<number>();
  let heldFrames = 0;
  for (const entry of order) {
    if (held.size === perMatchRuns.length - 1) break; // never hold back everything
    if (heldFrames + entry.size > wanted) continue; // overshooting the share is worse than undershooting it
    held.add(entry.index);
    heldFrames += entry.size;
  }

  // Every match is bigger than the share asked for. Hold the smallest one
  // anyway: a validation set that is larger than requested still measures
  // unseen play, and none at all measures nothing.
  if (held.size === 0) held.add(order[0].index);

  const train: TrainingRun[] = [];
  const validation: TrainingRun[] = [];
  perMatchRuns.forEach((runs, index) => {
    (held.has(index) ? validation : train).push(...runs);
  });
  return { train, validation };
}
