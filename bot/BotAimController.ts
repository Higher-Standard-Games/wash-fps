/**
 * BotAimController — turns a bot's view the way a hand moves a mouse.
 *
 * The brain decides where to look about 30 times a second and every decision
 * used to be the view: a new path corner or target snapped it round at once,
 * which read as spinning and aimbot flicks. The client now runs this once per
 * command it sends (125 Hz) between the wanted angles and the ones it sends:
 *
 * - Each axis follows its goal on a critically damped spring: it speeds up,
 *   slows into the goal and does not overshoot, with a top speed. Pitch turns
 *   at 60% of the yaw speed, as people move a mouse more sideways than up.
 * - A goal within the deadzone of the current one is ignored unless the bot is
 *   firing, so small changes of mind do not turn into movement.
 * - A goal more than 45° away waits for the bot's reaction time (±20%) before
 *   the view starts to turn, as a person has to notice before they turn.
 * - While firing, the view also follows the target's motion, as eyes and
 *   hand pursue a moving target, so tracking does not trail behind it.
 * - A slowly wandering offset, about a second per swing, replaces the old
 *   fresh noise on every decision, which shook the view.
 *
 * All rates come from the difficulty's trackingSpeed, reactionTimeMs and
 * aimAccuracy, so the presets need no new fields:
 *
 *   preset   top yaw speed   settle time   deadzone
 *   easy        150°/s          0.41 s        4°
 *   medium      300°/s          0.29 s        3°
 *   hard        500°/s          0.22 s        2°
 *   insane      800°/s          0.18 s        1.5°
 *
 * Pure apart from the random source, which tests replace.
 */

import type { BotDifficulty } from "./BotConfig";

const DEG = Math.PI / 180;

/** Top yaw speed per unit of trackingSpeed. */
const YAW_SPEED_PER_TRACKING = 100 * DEG;
const PITCH_SPEED_SCALE = 0.6;
/** Settle time at trackingSpeed 1; faster trackers settle in 1/√trackingSpeed of it. */
const BASE_SETTLE_SECONDS = 0.5;
/** A critically damped spring is within 5% of its goal after 4.74/ω. */
const SETTLE_OMEGA = 4.74;
/** A turn this large has to be noticed first. */
const REACTION_ANGLE = 45 * DEG;
const REACTION_JITTER = 0.2;
/** How long the aim offset keeps one heading on average, in seconds (±40%). */
const DRIFT_SECONDS = 1;
/** How quickly the offset glides toward a new heading, in seconds. */
const DRIFT_GLIDE_SECONDS = 0.3;
/** Width of the old uniform aim noise per unit of missing accuracy. */
const NOISE_WIDTH = 0.15;
const MAX_PITCH = 89 * DEG;
/** How much of each decision's measured target motion the pursuit takes on. */
const PURSUIT_BLEND = 0.5;
/** A bigger change between decisions is a new aim point, not the target moving. */
const PURSUIT_MAX_STEP = 10 * DEG;
/** Wanted angles unchanged this long mean the target has stopped. */
const PURSUIT_STALE_SECONDS = 0.1;

/** Deadzone by trackingSpeed, between the presets' points. */
const DEADZONE_POINTS: readonly (readonly [number, number])[] = [
  [1.5, 4 * DEG],
  [3, 3 * DEG],
  [5, 2 * DEG],
  [8, 1.5 * DEG],
];

export interface AimTuning {
  /** rad/s */
  maxYawSpeed: number;
  /** rad/s */
  maxPitchSpeed: number;
  /** Seconds to within 5% of a goal the top speed does not limit. */
  settleSeconds: number;
  /** rad */
  deadzone: number;
  /** Mean delay before a turn over 45°, ms. */
  reactionMs: number;
  /** Standard deviation of the wandering aim offset, rad. */
  driftSigma: number;
}

export type AimDifficulty = Pick<BotDifficulty, "trackingSpeed" | "reactionTimeMs" | "aimAccuracy">;

export function aimTuning(difficulty: AimDifficulty): AimTuning {
  const tracking = Math.max(0.1, difficulty.trackingSpeed);
  const maxYawSpeed = YAW_SPEED_PER_TRACKING * tracking;
  const missing = Math.max(0, Math.min(1, 1 - difficulty.aimAccuracy));
  return {
    maxYawSpeed,
    maxPitchSpeed: maxYawSpeed * PITCH_SPEED_SCALE,
    settleSeconds: BASE_SETTLE_SECONDS / Math.sqrt(tracking),
    deadzone: deadzoneFor(tracking),
    reactionMs: Math.max(0, difficulty.reactionTimeMs),
    // The old noise was uniform over NOISE_WIDTH·missing: keep its spread.
    driftSigma: (NOISE_WIDTH * missing) / Math.sqrt(12),
  };
}

function deadzoneFor(tracking: number): number {
  const points = DEADZONE_POINTS;
  if (tracking <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (tracking <= x1) {
      const [x0, y0] = points[i - 1];
      return y0 + ((y1 - y0) * (tracking - x0)) / (x1 - x0);
    }
  }
  return points[points.length - 1][1];
}

/** An angle wrapped to (−π, π]. */
export function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

interface Axis {
  value: number;
  velocity: number;
  goal: number;
  /** Aim error now, and where it is wandering to. */
  offset: number;
  driftTarget: number;
  driftLeft: number;
  /** The last wanted angle, how long ago it last changed, and how fast it moves (rad/s). */
  wanted: number;
  heldFor: number;
  pursuit: number;
}

const axis = (value: number): Axis => ({
  value,
  velocity: 0,
  goal: value,
  offset: 0,
  driftTarget: 0,
  driftLeft: 0,
  wanted: value,
  heldFor: 0,
  pursuit: 0,
});

export class BotAimController {
  private _tuning: AimTuning;
  private _yaw: Axis | null = null;
  private _pitch: Axis = axis(0);
  /** A large turn waiting for the reaction time. */
  private _pending: { yaw: number; pitch: number; remaining: number } | null = null;

  constructor(
    difficulty: AimDifficulty,
    private readonly _random: () => number = Math.random,
  ) {
    this._tuning = aimTuning(difficulty);
  }

  get tuning(): AimTuning {
    return this._tuning;
  }

  setDifficulty(difficulty: AimDifficulty): void {
    this._tuning = aimTuning(difficulty);
  }

  /** Whether the view has a position yet; the first step starts from the wanted angles otherwise. */
  get started(): boolean {
    return this._yaw !== null;
  }

  /** The view as last sent, or null before the first step. */
  get view(): { yaw: number; pitch: number } | null {
    return this._yaw ? { yaw: this._yaw.value, pitch: this._pitch.value } : null;
  }

  /** Forget the view, as when the bot leaves the server. */
  clear(): void {
    this._yaw = null;
    this._pending = null;
  }

  /** Look exactly here now, at rest: on spawn, and after a script set the view itself. */
  reset(yaw: number, pitch: number): void {
    this._yaw = axis(yaw);
    this._pitch = axis(pitch);
    this._pending = null;
  }

  /**
   * Advance by `dt` seconds toward the wanted angles and return the view to
   * send. `firing` turns off the deadzone, so a bot shooting keeps tracking.
   */
  step(dt: number, wantedYaw: number, wantedPitch: number, firing: boolean): { yaw: number; pitch: number } {
    if (!this._yaw) this.reset(wantedYaw, wantedPitch);
    const yaw = this._yaw as Axis;
    const pitch = this._pitch;
    const t = this._tuning;

    track(yaw, wantedYaw, dt);
    track(pitch, wantedPitch, dt);
    this._chooseGoal(dt, wantedYaw, wantedPitch, firing);
    this._drift(yaw, dt);
    this._drift(pitch, dt);

    // Pursue only a target being shot at, and not one still to react to.
    const pursue = firing && !this._pending;
    const yawSpeed = pursue ? yaw.pursuit : 0;
    const yawTarget = yaw.value + wrapAngle(yaw.goal + yaw.offset + yawSpeed * yaw.heldFor - yaw.value);
    yaw.value = wrapAngle(follow(yaw, yawTarget, yawSpeed, t.maxYawSpeed, t, dt));
    const pitchSpeed = pursue ? pitch.pursuit : 0;
    const pitchTarget = clampPitch(pitch.goal + pitch.offset + pitchSpeed * pitch.heldFor);
    pitch.value = clampPitch(follow(pitch, pitchTarget, pitchSpeed, t.maxPitchSpeed, t, dt));
    return { yaw: yaw.value, pitch: pitch.value };
  }

  private _chooseGoal(dt: number, wantedYaw: number, wantedPitch: number, firing: boolean): void {
    const yaw = this._yaw as Axis;
    const pitch = this._pitch;
    const jump = Math.max(Math.abs(wrapAngle(wantedYaw - yaw.goal)), Math.abs(wantedPitch - pitch.goal));

    if (jump > REACTION_ANGLE && this._tuning.reactionMs > 0) {
      if (!this._pending) {
        const jitter = 1 + (this._random() * 2 - 1) * REACTION_JITTER;
        this._pending = { yaw: wantedYaw, pitch: wantedPitch, remaining: (this._tuning.reactionMs / 1000) * jitter };
      }
      this._pending.yaw = wantedYaw;
      this._pending.pitch = wantedPitch;
      this._pending.remaining -= dt;
      if (this._pending.remaining > 0) return;
      yaw.goal = wantedYaw;
      pitch.goal = wantedPitch;
      this._pending = null;
      return;
    }
    // Back within reach before the bot reacted: it never turned away.
    this._pending = null;

    const deadzone = firing ? 0 : this._tuning.deadzone;
    if (Math.abs(wrapAngle(wantedYaw - yaw.goal)) > deadzone) yaw.goal = wantedYaw;
    if (Math.abs(wantedPitch - pitch.goal) > deadzone) pitch.goal = wantedPitch;
  }

  /**
   * The aim error glides to a fresh random offset about once a second, so it
   * wanders smoothly with spread driftSigma rather than shaking each command.
   */
  private _drift(a: Axis, dt: number): void {
    const sigma = this._tuning.driftSigma;
    if (sigma <= 0) {
      a.offset = 0;
      return;
    }
    a.driftLeft -= dt;
    if (a.driftLeft <= 0) {
      a.driftTarget = sigma * this._gaussian();
      a.driftLeft = DRIFT_SECONDS * (0.6 + 0.8 * this._random());
    }
    a.offset += (a.driftTarget - a.offset) * (1 - Math.exp(-dt / DRIFT_GLIDE_SECONDS));
  }

  private _gaussian(): number {
    const u = Math.max(1e-12, this._random());
    const v = this._random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

const clampPitch = (pitch: number) => Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));

/**
 * Follow how fast the wanted angle moves. Decisions arrive a few commands
 * apart, so the rate is each change over the time since the one before.
 */
function track(a: Axis, wanted: number, dt: number): void {
  a.heldFor += dt;
  const change = wrapAngle(wanted - a.wanted);
  if (change === 0) {
    if (a.heldFor > PURSUIT_STALE_SECONDS) a.pursuit = 0;
    return;
  }
  if (Math.abs(change) > PURSUIT_MAX_STEP) a.pursuit = 0;
  else a.pursuit += (change / a.heldFor - a.pursuit) * PURSUIT_BLEND;
  a.wanted = wanted;
  a.heldFor = 0;
}

/**
 * One step of a critically damped spring from `a.value` toward `target`,
 * which moves at `targetSpeed` (Game Programming Gems 4, 1.10, in the
 * target's frame: exact for any step), with the speed held under `maxSpeed`.
 * Updates `a.velocity`; returns the new value.
 */
function follow(a: Axis, target: number, targetSpeed: number, maxSpeed: number, t: AimTuning, dt: number): number {
  const omega = SETTLE_OMEGA / t.settleSeconds;
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const error = a.value - target;
  const relative = a.velocity - targetSpeed;
  const temp = (relative + omega * error) * dt;
  let velocity = (relative - omega * temp) * decay + targetSpeed;
  let next = target + targetSpeed * dt + (error + temp) * decay;

  if (Math.abs(velocity) > maxSpeed) velocity = Math.sign(velocity) * maxSpeed;
  const moved = next - a.value;
  if (Math.abs(moved) > maxSpeed * dt) next = a.value + Math.sign(moved) * maxSpeed * dt;
  a.velocity = velocity;
  return next;
}
