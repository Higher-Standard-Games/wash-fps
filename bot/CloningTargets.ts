/**
 * Turning a recorded human frame into what the network should have answered.
 *
 * This is behaviour cloning: the label is **what the person did**, not how well
 * it went. The previous scheme built every target from the frame's reward —
 * `(reward + 1) / 2` — which meant that on a neutral frame, which is most of
 * them, every target became 0.5 whatever the human had done, and the network
 * learned nothing from the majority of its data.
 *
 * Reward is not useless; it is the right signal for self-play sharpening later.
 * It is simply not an answer to "what would a person do here".
 *
 * TF-4 in docs/research/BOT_TF_IMPROVEMENTS.md.
 */

import { InputButtons } from "./BotConfig";
import type { TrainingFrame } from "./BotEpisodeRecorder";
import { FeatureHistory, FRAME_STACK, MAX_FRAME_GAP_TICKS } from "./ModelInputs";

/** Tactical head, 5 outputs. Index order matches HybridBrain's TACT map. */
export const TACTICAL_TARGET_SIZE = 5;
/** Combat head, 6 outputs. Index order matches HybridBrain's COMBAT map. */
export const COMBAT_TARGET_SIZE = 6;

/**
 * How an output is read, and so how it is trained.
 *
 * A **probability** is a yes-or-no a person gives with a button: its output is a
 * logit, trained with binary cross-entropy and read through a sigmoid. A **turn**
 * is how far the view moved between two frames: its output is a signed number in
 * turn units, trained with Huber loss and read as radians. They used to be one
 * kind — a sigmoid on everything, trained on squared error — which squeezed a turn
 * into the 0-to-1 range around 0.5, where a typical correction moved the label by
 * a hundredth and there was almost nothing to learn.
 */
export type OutputKind = "probability" | "turn";

/** Tactical: sprint, slide, jump, switch, slot — all answered yes-or-no, the slot as a share of nine. */
export const TACTICAL_OUTPUT_KINDS: readonly OutputKind[] = [
  "probability",
  "probability",
  "probability",
  "probability",
  "probability",
];

/** Combat: fire, alt-fire, aim yaw, aim pitch, dodge left, dodge right. */
export const COMBAT_OUTPUT_KINDS: readonly OutputKind[] = [
  "probability",
  "probability",
  "turn",
  "turn",
  "probability",
  "probability",
];

/**
 * Radians per turn unit. A tenth of a radian is a brisk correction between two
 * snapshots, so ordinary tracking lands around one unit, where a network learns
 * best, and a flick lands at several.
 */
export const AIM_TURN_SCALE = 0.1;

/**
 * The largest turn a label keeps, in radians. Beyond a radian between two
 * snapshots is a flick to somewhere else entirely, not tracking, and Huber loss
 * already limits how hard one can pull; this only keeps a wrapped angle or a
 * glitch from producing a label of thirty units.
 */
export const MAX_AIM_TURN = 1.0;

/**
 * Slots a weapon label is spread over: the keyboard's worth of them.
 *
 * A commanded slot is a 1-based index into the player's own inventory, which the
 * server resolves against the weapons they are actually carrying. Fixing the
 * range at nine keeps one output meaning one slot however many weapons happen to
 * be held — encoding against the current inventory size instead would make the
 * same number mean a different weapon from one pickup to the next, which is not
 * something a network can learn.
 */
export const MAX_WEAPON_SLOT = 9;

/** A commanded slot as a [0,1] label. Zero means no weapon named. */
export function encodeWeaponSlot(slot: number): number {
  return Math.max(0, Math.min(1, slot / MAX_WEAPON_SLOT));
}

/**
 * A head's weapon output back to a slot number, or 0 for none.
 *
 * The inverse of the label, so the two sides cannot drift apart. The caller
 * still has to check the slot against what the bot is carrying.
 */
export function decodeWeaponSlot(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const slot = Math.round(Math.max(0, Math.min(1, value)) * MAX_WEAPON_SLOT);
  return slot;
}

const held = (buttons: number, bit: number): number => ((buttons & bit) !== 0 ? 1 : 0);

/** Shortest signed distance from `from` to `to` on a circle, in radians. */
export function angleDelta(from: number, to: number): number {
  let delta = to - from;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  return delta;
}

/** A turn in radians as a label, in turn units. Zero is no turn. */
export function encodeAimTurn(radians: number): number {
  if (!Number.isFinite(radians)) return 0;
  return Math.max(-MAX_AIM_TURN, Math.min(MAX_AIM_TURN, radians)) / AIM_TURN_SCALE;
}

/**
 * A turn output back to radians — the inverse of the label, so the two sides
 * cannot drift apart the way they had: the label said `(output − 0.5) × 2`
 * radians and the brain applied `(output − 0.5) × 0.6`, behind a dead zone wider
 * than most turns a person makes between two snapshots.
 */
export function decodeAimTurn(value: number): number {
  return Number.isFinite(value) ? value * AIM_TURN_SCALE : 0;
}

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/**
 * A head's raw outputs in the space its labels live in: probabilities through a
 * sigmoid, turns in turn units as they are. What the held-out report scores.
 */
export function toLabelSpace(raw: ArrayLike<number>, kinds: readonly OutputKind[]): number[] {
  return kinds.map((kind, index) => (kind === "probability" ? sigmoid(raw[index]) : raw[index]));
}

/**
 * A head's raw outputs as the brain acts on them: probabilities, and turns in
 * radians.
 */
export function decodeOutputs(raw: ArrayLike<number>, kinds: readonly OutputKind[]): number[] {
  return kinds.map((kind, index) => (kind === "probability" ? sigmoid(raw[index]) : decodeAimTurn(raw[index])));
}

/**
 * A probability made more or less decisive before it is sampled.
 *
 * At temperature 1 a button is pressed exactly as often as the network thinks a
 * person would; lower sharpens toward the likelier answer and 0 always takes it,
 * which is a plain threshold at one half.
 */
export function sharpen(probability: number, temperature: number): number {
  if (!Number.isFinite(probability)) return 0;
  const p = Math.max(0, Math.min(1, probability));
  if (temperature <= 0) return p > 0.5 ? 1 : 0;
  const yes = p ** (1 / temperature);
  const no = (1 - p) ** (1 / temperature);
  return yes + no === 0 ? 0.5 : yes / (yes + no);
}

/**
 * What the tactical head should have said, from what the person did.
 *
 * Every output here is something a person pressed. The head used to carry three
 * more — FIGHT, RETREAT and HUNT — which nobody can label, because a player
 * never emits "my mode is HUNT". They were derived from behaviour instead, which
 * made them a guess dressed as a target; two of the three were then never read
 * at inference, and the third overrode the state machine on the strength of
 * "hurt and walking backwards". Which mode to be in stays the state machine's
 * decision, and belongs to self-play, where the bot knows its own.
 */
export function buildTacticalTarget(frame: TrainingFrame, previous?: TrainingFrame): number[] {
  const { buttons, weaponSlot } = frame.action;
  const target = new Array<number>(TACTICAL_TARGET_SIZE).fill(0);

  // 0-2: movement, straight from the buttons the person held
  target[0] = held(buttons, InputButtons.SPRINT);
  target[1] = held(buttons, InputButtons.CROUCH);
  target[2] = held(buttons, InputButtons.JUMP);

  // 3-4: weapon — did they switch, and to what
  const switched = previous !== undefined && previous.action.weaponSlot !== weaponSlot;
  target[3] = switched ? 1 : 0;
  target[4] = encodeWeaponSlot(weaponSlot);

  return target;
}

/**
 * What the combat head should have said.
 *
 * Aim is the part worth having: view angles are recorded state, so the turn a
 * person made between two frames is the one label in this whole pipeline that
 * was never a guess. Buttons are 0 or 1; the turns are in turn units, signed.
 */
export function buildCombatTarget(frame: TrainingFrame, previous?: TrainingFrame): number[] {
  const { buttons } = frame.action;
  const target = new Array<number>(COMBAT_TARGET_SIZE).fill(0);

  target[0] = held(buttons, InputButtons.FIRE);
  target[1] = held(buttons, InputButtons.ALT_FIRE);

  // 2-3: where the view actually went, not where it ended up. With no frame
  // before this one to measure from, the label is no turn.
  if (previous) {
    target[2] = encodeAimTurn(angleDelta(previous.action.yaw, frame.action.yaw));
    target[3] = encodeAimTurn(angleDelta(previous.action.pitch, frame.action.pitch));
  }

  // 4-5: strafing, from the wish direction the person gave — not from velocity,
  // which in an air-strafe points somewhere the player never pressed
  target[4] = frame.action.directionX < -0.3 ? 1 : 0;
  target[5] = frame.action.directionX > 0.3 ? 1 : 0;

  return target;
}

/**
 * What each tactical output answers, in index order.
 *
 * One mean-squared number over a whole head says nothing about which question
 * the network is getting wrong, and these outputs are not the same kind of
 * question: a button is a yes, a slot is a which.
 */
export const TACTICAL_OUTPUT_NAMES = ["sprint", "slide", "jump", "switch", "slot"] as const;

/** What each combat output answers, in index order. */
export const COMBAT_OUTPUT_NAMES = ["fire", "alt-fire", "aim yaw", "aim pitch", "dodge left", "dodge right"] as const;

export interface TrainingPair {
  input: number[];
  target: number[];
  /**
   * The frame's reward, normalised to [-1, 1], carried along rather than mixed
   * into the target. Cloning a person ignores it — what they did is the answer
   * whether or not the frame went well. Self-play uses it to decide how often a
   * frame is trained on, which is where a reward belongs: it says how much to
   * listen, not what to say.
   */
  reward: number;
}

/**
 * How much each frame of a round should count, from its reward.
 *
 * The typical frame counts normally (0.5), a frame that went better counts more,
 * one that went worse counts less, up to 1 and down to 0. "Typical" is the median
 * and the scale is the largest distance from it, because rewards arrive min-max
 * normalised per episode: an episode with one kill and no death put that kill at
 * +1 and every other frame at −1, and weighting from the raw value then counted
 * one frame of the whole round and ignored the rest. Centring on the median leaves
 * the ordinary frames ordinary whichever extreme an episode happened to contain.
 *
 * A reward that is not a number weighs nothing.
 */
export function rewardWeights(rewards: readonly number[]): number[] {
  const finite = rewards.filter((reward) => Number.isFinite(reward)).sort((a, b) => a - b);
  if (finite.length === 0) return rewards.map(() => 0);
  const middle = Math.floor(finite.length / 2);
  const median = finite.length % 2 === 0 ? (finite[middle - 1] + finite[middle]) / 2 : finite[middle];
  const spread = finite.reduce((widest, reward) => Math.max(widest, Math.abs(reward - median)), 0);
  return rewards.map((reward) => {
    if (!Number.isFinite(reward)) return 0;
    if (spread === 0) return 0.5;
    return 0.5 + 0.5 * ((reward - median) / spread);
  });
}

/**
 * Draw `count` items in proportion to their weights, by systematic resampling.
 *
 * This is how a round's reward weights reach training. TensorFlow.js does not
 * support per-sample weights in `fit` — passing them throws — so the weights
 * decide which frames are trained on instead: a frame twice as heavy appears
 * about twice as often, and one that weighs nothing not at all. In expectation it
 * is the same as weighting the loss, with nothing asked of the API.
 *
 * `offset` in [0, 1) is where the first draw falls; the rest are evenly spaced,
 * which keeps the draw close to the weights even for a small `count`.
 */
export function resampleByWeight<T>(
  items: readonly T[],
  weights: readonly number[],
  count: number,
  offset: number,
): T[] {
  const total = weights.reduce((sum, weight) => sum + (weight > 0 ? weight : 0), 0);
  if (items.length === 0 || total <= 0 || count <= 0) return [];
  const step = total / count;
  const drawn: T[] = [];
  let position = Math.max(0, Math.min(0.999999, offset)) * step;
  let cumulative = 0;
  let index = 0;
  for (let draw = 0; draw < count; draw++) {
    while (index < items.length - 1 && cumulative + Math.max(0, weights[index]) <= position) {
      cumulative += Math.max(0, weights[index]);
      index++;
    }
    drawn.push(items[index]);
    position += step;
  }
  return drawn;
}

/**
 * Build training pairs for one run — one player, one match, in order.
 *
 * Runs matter because the aim labels are *differences* and the inputs are
 * *stacks*. Concatenate two players and the frame before the seam belongs to
 * someone else, so the network is taught a turn nobody made, and shown a
 * movement that started as one player and finished as another.
 *
 * `frameWidth` is the width of one frame's vector; the input each pair carries
 * is `depth` of them end to end, built by the same `FeatureHistory` a bot uses in
 * a match. A frame whose vector is missing, the wrong width or not all numbers
 * is dropped and breaks the stack — whatever comes after it did not follow on
 * from what came before, as far as the network could ever tell.
 */
export function buildRunPairs(
  run: readonly TrainingFrame[],
  head: "tactical" | "combat",
  frameWidth: number,
  depth: number = FRAME_STACK,
): TrainingPair[] {
  const pairs: TrainingPair[] = [];
  const history = new FeatureHistory(depth);
  for (let index = 0; index < run.length; index++) {
    const frame = run[index];
    const previous = index > 0 ? adjacentOrNothing(run[index - 1], frame) : undefined;
    const vector = head === "tactical" ? frame.tacticalInput : frame.combatInput;

    // One non-finite number turns the loss to NaN and takes the weights with
    // it, silently and irreversibly. A corrupt frame is not worth a training
    // run, so it is dropped here rather than discovered afterwards — and kept
    // out of the stack, where it would poison the frames after it too.
    if (!vector || vector.length !== frameWidth || !allFinite(vector)) {
      history.clear();
      continue;
    }
    history.push(vector, frame.tick);

    const target = head === "tactical" ? buildTacticalTarget(frame, previous) : buildCombatTarget(frame, previous);
    if (!allFinite(target)) continue;

    pairs.push({ input: history.stacked(), target, reward: frame.reward });
  }
  return pairs;
}

/** Every element present and a real number. */
function allFinite(values: readonly number[]): boolean {
  return values.every((value) => Number.isFinite(value));
}

/**
 * The previous frame, but only if it really is the previous frame.
 *
 * Array adjacency is not time adjacency: see MAX_FRAME_GAP_TICKS.
 */
export function adjacentOrNothing(
  previous: TrainingFrame,
  frame: TrainingFrame,
  maxGap = MAX_FRAME_GAP_TICKS,
): TrainingFrame | undefined {
  const gap = frame.tick - previous.tick;
  return gap > 0 && gap <= maxGap ? previous : undefined;
}

/**
 * Build pairs across many runs, each kept separate, and account for every frame
 * that did not become one.
 *
 * `absent` frames had nothing for this head — for the combat head, no enemy to
 * be about — which is the ordinary state of most of a match, not a fault.
 * `dropped` frames had a vector that could not be used: the wrong width, or a
 * value that is not a number. A silent drop is how a training set quietly
 * becomes a tenth of what the operator believes it is, so both are counted.
 */
export function buildCorpusPairs(
  runs: readonly (readonly TrainingFrame[])[],
  head: "tactical" | "combat",
  frameWidth: number,
  depth: number = FRAME_STACK,
): { pairs: TrainingPair[]; dropped: number; absent: number } {
  const pairs = runs.flatMap((run) => buildRunPairs(run, head, frameWidth, depth));
  let total = 0;
  let absent = 0;
  for (const run of runs) {
    for (const frame of run) {
      total++;
      if ((head === "tactical" ? frame.tacticalInput : frame.combatInput) == null) absent++;
    }
  }
  return { pairs, dropped: total - absent - pairs.length, absent };
}
