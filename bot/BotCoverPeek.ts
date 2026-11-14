/**
 * BotCoverPeek — fighting from the edge of cover.
 *
 * At range a good player does not trade shots in the open: they stand by a
 * pillar or a doorframe, step out to shoot and back while the weapon reloads,
 * so the enemy gets a window to hit them rather than the whole fight.
 *
 * Every COVER_CHECK_TICKS of a ranged fight the bot looks either side of
 * itself, square to the enemy, for the nearest spot the enemy cannot see
 * (rolled at the bot's skill). With one, it ducks there after each shot of a
 * slow weapon and steps back out just before the next is ready; with a fast
 * weapon it ducks between bursts. Without one it fights in the open.
 */

import type { Vec3 } from "./BotGameState";

const TICK_RATE = 125;
/** How often the sides are looked at again. */
const COVER_CHECK_TICKS = Math.round(0.5 * TICK_RATE);
/** How far to the side a hidden spot is looked for, units. */
const COVER_OFFSETS = [64, 112, 160, 208] as const;
/** Strafing speed the step timing assumes, units per second. */
const STEP_SPEED = 320;
/** A weapon this slow or slower is peeked shot by shot; faster ones in bursts. */
const SLOW_REFIRE_TICKS = Math.round(0.5 * TICK_RATE);
/** Bursts of a fast weapon, and the ducks between them. */
const BURST_TICKS = [Math.round(0.6 * TICK_RATE), Math.round(1.0 * TICK_RATE)] as const;
const DUCK_TICKS = [Math.round(0.35 * TICK_RATE), Math.round(0.5 * TICK_RATE)] as const;
/** Out of sight in cover, the fight is held this long (or a reload and a step) before it counts as lost. */
const HOLD_TICKS = TICK_RATE;

export interface CoverQuery {
  tick: number;
  self: Vec3;
  /** Yaw towards the enemy. */
  yaw: number;
  /** Whether a spot is out of the enemy's sight. */
  hidden: (at: Vec3) => boolean;
  /** Whether the bot can walk straight from where it is to there. */
  walkable: (to: Vec3) => boolean;
  /** Ticks between shots of the weapon out. */
  refireTicks: number;
  /** When the bot last fired it. */
  firedTick: number;
  /** Whether the enemy is in sight now. */
  visible: boolean;
}

/** −1 strafe left, 1 right, 0 stand. */
export type PeekMove = -1 | 0 | 1;

export class BotCoverPeek {
  private _side: -1 | 0 | 1 = 0;
  private _offset = 0;
  private _checkTick = Number.NEGATIVE_INFINITY;
  private _cycleStart = 0;
  private _burst = 0;
  private _duck = 0;
  private _lastStepTick = Number.NEGATIVE_INFINITY;
  private _lastVisibleTick = Number.NEGATIVE_INFINITY;
  private _holdTicks = HOLD_TICKS;

  constructor(
    private readonly _skill: number,
    private readonly _random: () => number = Math.random,
  ) {}

  reset(): void {
    this._side = 0;
    this._checkTick = Number.NEGATIVE_INFINITY;
    this._lastStepTick = Number.NEGATIVE_INFINITY;
  }

  /**
   * True while the bot is using cover and has seen the enemy lately: a duck
   * out of sight is still the same fight.
   */
  holding(tick: number): boolean {
    return this._side !== 0 && tick - this._lastStepTick <= 2 && tick - this._lastVisibleTick <= this._holdTicks;
  }

  /** The move that peeks from cover, or null to fight in the open. */
  step(q: CoverQuery): PeekMove | null {
    if (q.visible) this._lastVisibleTick = q.tick;
    if (q.tick >= this._checkTick) {
      this._checkTick = q.tick + COVER_CHECK_TICKS;
      const had = this._side;
      this._side = 0;
      // Looked for from the open only: from cover every side looks hidden.
      if (q.visible && this._random() < this._skill) this._find(q);
      else if (!q.visible && had !== 0) this._side = had;
      if (this._side !== 0 && had === 0) this._newCycle(q.tick);
    }
    if (this._side === 0) return null;
    this._lastStepTick = q.tick;
    const step = Math.min(
      Math.round(TICK_RATE / 2),
      Math.max(Math.round(0.12 * TICK_RATE), Math.round((this._offset / STEP_SPEED) * TICK_RATE)),
    );
    this._holdTicks = Math.max(HOLD_TICKS, q.refireTicks + step);
    const side = this._side;
    if (q.refireTicks >= SLOW_REFIRE_TICKS) {
      if (q.refireTicks < 2 * step + 10) return null;
      const since = q.tick - q.firedTick;
      if (since < step) return side;
      if (since < q.refireTicks - step) return 0;
      // Out again; in sight, fight as in the open until the shot is gone.
      return q.visible ? null : (-side as PeekMove);
    }
    // A fast weapon: a burst in sight, then a duck into cover and back.
    const at = q.tick - this._cycleStart;
    if (at < this._burst) return q.visible ? null : (-side as PeekMove);
    if (at < this._burst + step) return side;
    if (at < this._burst + this._duck) return 0;
    if (at < this._burst + this._duck + step) return -side as PeekMove;
    this._newCycle(q.tick);
    return null;
  }

  private _newCycle(tick: number): void {
    this._cycleStart = tick;
    this._burst = Math.round(BURST_TICKS[0] + this._random() * (BURST_TICKS[1] - BURST_TICKS[0]));
    this._duck = Math.round(DUCK_TICKS[0] + this._random() * (DUCK_TICKS[1] - DUCK_TICKS[0]));
  }

  /** The nearer side with a hidden spot, and how far it is. */
  private _find(q: CoverQuery): void {
    // Right of the view is (cos yaw, −sin yaw) in x/z.
    const rx = Math.cos(q.yaw);
    const rz = -Math.sin(q.yaw);
    const first: -1 | 1 = this._random() < 0.5 ? 1 : -1;
    for (const offset of COVER_OFFSETS) {
      for (const side of [first, -first as -1 | 1]) {
        const at = { x: q.self.x + rx * side * offset, y: q.self.y, z: q.self.z + rz * side * offset };
        if (!q.hidden(at) || !q.walkable(at)) continue;
        this._side = side;
        this._offset = offset;
        return;
      }
    }
  }
}
