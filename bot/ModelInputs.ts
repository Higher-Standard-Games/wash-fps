/**
 * The network's inputs, built one way for training and for play.
 *
 * A model is only as good as the promise that the vector it is fed in a match
 * was built the same way as the vectors it learned from. That promise used to be
 * kept by two copies of the same few lines — one in the demo extractor, one in
 * `HybridBrain` — and they had drifted: training built the tactical vector with
 * no map, so the distances to the nearest health and armour were always "far",
 * while a bot in a match fed real distances; and training aimed the combat
 * vector at the nearest enemy while a bot aimed it at the first one in line of
 * sight, which in a full server-side snapshot is often a different player
 * entirely. Every choice about what goes into a vector now lives here.
 */

import type { BotGameState, VisiblePlayer } from "./BotGameState";
import { buildCombatInput, buildTacticalInput, COMBAT_INPUT_SIZE, TACTICAL_INPUT_SIZE } from "./BotInputNormalizer";
import type { BotVision, VisionResult } from "./BotVision";

/**
 * How many consecutive frames the network sees at once, oldest first.
 *
 * One frame is a still. Whether a player is starting a strafe-jump or finishing
 * one, closing on an item or leaving it, is invisible in a single vector and
 * obvious in three. Frames are one snapshot apart on both sides — a demo writes
 * one per snapshot and a bot decides on each snapshot it receives — so a stack
 * spans the same stretch of time in training and in a match, provided the
 * server's snapshot rate is the same.
 */
export const FRAME_STACK = 3;

/** What the tactical model takes: FRAME_STACK tactical vectors end to end. */
export const TACTICAL_MODEL_INPUT = TACTICAL_INPUT_SIZE * FRAME_STACK;
/** What the combat model takes: FRAME_STACK combat vectors end to end. */
export const COMBAT_MODEL_INPUT = COMBAT_INPUT_SIZE * FRAME_STACK;

/**
 * How far apart two frames may be and still be treated as consecutive.
 *
 * A player's frames have holes in them. Training skips every frame where the
 * player is dead or not in the roster; a bot is not asked to decide while it is
 * dead. Either way the next frame can be a respawn hundreds of ticks later, and
 * treating it as following on from the moment of death invents a turn nobody
 * made and a movement nobody was in the middle of.
 *
 * Twelve ticks is roomy for real adjacency (a 125 Hz simulation at 60 Hz
 * snapshots is about two, at 20 Hz about six) and far below any death gap,
 * which a respawn delay alone puts past a hundred.
 */
export const MAX_FRAME_GAP_TICKS = 12;

/**
 * The enemy the combat head is asked about: the first one in line of sight, or
 * the nearest when none is visible or there is no map to trace against.
 */
export function selectCombatTarget(
  state: BotGameState,
  visionResult: Pick<VisionResult, "visibleEnemies"> | null | undefined,
): VisiblePlayer | null {
  return visionResult?.visibleEnemies?.[0]?.player ?? state.getNearestEnemy();
}

export interface ModelInputs {
  tactical: number[];
  /** Absent when there is no enemy to be about. */
  combat: number[] | null;
}

/**
 * Both vectors for one decision.
 *
 * `vision` is the viewer's own perception — a fork per player, as a bot has —
 * and `visionResult` is what it saw this frame. Both may be null when the map is
 * not available, and then both sides fall back the same way.
 */
export function buildModelInputs(
  state: BotGameState,
  vision: BotVision | null,
  visionResult: Pick<VisionResult, "visibleEnemies"> | null,
): ModelInputs {
  const target = selectCombatTarget(state, visionResult);
  return {
    tactical: Array.from(buildTacticalInput(state, vision)),
    combat: target ? Array.from(buildCombatInput(state, target)) : null,
  };
}

/**
 * The last few vectors of one stream — one player's tactical features, say —
 * and the stacked input they make.
 *
 * The same class is used by training and by a bot in a match, so the two cannot
 * disagree about what a stack is. It applies the gap rule itself rather than
 * trusting its caller to clear it: a bot is never asked to decide while dead, so
 * nothing would ever tell it a death happened except the tick.
 *
 * Until enough frames exist — the start of a run, or just after a gap — the
 * oldest frame it has is repeated. That says "nothing was changing", which is
 * what a respawn looks like; padding with zeros would say dead, unarmed and
 * standing still, which these features really do mean.
 */
export class FeatureHistory {
  private readonly _frames: number[][] = [];
  private _lastTick: number | null = null;

  constructor(
    private readonly _depth: number = FRAME_STACK,
    private readonly _maxGap: number = MAX_FRAME_GAP_TICKS,
  ) {}

  /** Forget everything, as after a frame the stream could not use. */
  clear(): void {
    this._frames.length = 0;
    this._lastTick = null;
  }

  /** Add the newest frame, starting over if it does not follow the last one. */
  push(frame: readonly number[], tick: number): void {
    if (this._lastTick !== null) {
      const gap = tick - this._lastTick;
      if (gap <= 0 || gap > this._maxGap) this.clear();
    }
    this._frames.push([...frame]);
    if (this._frames.length > this._depth) this._frames.shift();
    this._lastTick = tick;
  }

  /** Oldest first, newest last, padded by repeating the oldest. Empty if nothing was pushed. */
  stacked(): number[] {
    if (this._frames.length === 0) return [];
    const stacked: number[] = [];
    for (let pad = this._frames.length; pad < this._depth; pad++) stacked.push(...this._frames[0]);
    for (const frame of this._frames) stacked.push(...frame);
    return stacked;
  }

  /** How many real frames are behind the current stack. */
  get size(): number {
    return this._frames.length;
  }
}

/**
 * The usual number of ticks between one frame and the next, or null with fewer
 * than two frames that follow on.
 *
 * A stack of three frames means "the last two snapshot intervals", and that is
 * only the same stretch of time in training and in a match if the two run at the
 * same snapshot rate. Measuring it in ticks, from the frames themselves, compares
 * like with like on both sides — a demo header's rate is rounded to a whole
 * number, and a bot is never told the rate at all. Gaps longer than the stack
 * would bridge are deaths and absences, not intervals, and are left out.
 */
export function typicalInterval(ticks: readonly number[]): number | null {
  const intervals: number[] = [];
  for (let index = 1; index < ticks.length; index++) {
    const gap = ticks[index] - ticks[index - 1];
    if (gap > 0 && gap <= MAX_FRAME_GAP_TICKS) intervals.push(gap);
  }
  if (intervals.length === 0) return null;
  intervals.sort((a, b) => a - b);
  return intervals[Math.floor(intervals.length / 2)];
}

/**
 * Why a bot's frames are not spaced like the frames it learned from, or null if
 * they are close enough that a stack means the same thing.
 */
export function intervalMismatch(trainedTicks: number, observedTicks: number): string | null {
  const ratio = Math.max(trainedTicks, observedTicks) / Math.min(trainedTicks, observedTicks);
  if (ratio <= 1.25) return null;
  return (
    `trained on frames ${trainedTicks} tick(s) apart, but this server sends a snapshot every ` +
    `${observedTicks} — a stack of ${FRAME_STACK} spans ${(observedTicks / trainedTicks).toFixed(1)}× the time it ` +
    `did in training, so every movement reads ${observedTicks > trainedTicks ? "faster" : "slower"} than it is`
  );
}
