/**
 * BotCombatMovement — how a bot moves while it fights.
 *
 * It used to flip its strafe every 30–70 decisions and jump on a 0.4% roll,
 * which is easy to read and easy to hit. Now:
 *
 * - Strafe runs last 0.25–0.9 s. A skilled bot also stops dead or doubles back
 *   briefly now and then; an unskilled one keeps a steadier rhythm.
 * - Taking a hit sets off a dodge: a jump, or from a sprint a slide.
 * - A rocket or grenade on course for the bot is sidestepped, away from its
 *   path, once the bot has had time to notice it; a skilled bot jumps it too.
 * - Jumps are reserved for a noticed threat; ordinary fighting stays grounded.
 * - With a splash weapon, a nearby ledge above the enemy is worth taking:
 *   rockets into their feet from there are hard to avoid (`findHighGround`).
 *
 * `dodgeSkill` sets how often and how well; `strafeJumpSkill` the hopping;
 * `reactionTimeMs` how soon a rocket is noticed.
 */

import type { BotDifficulty } from "./BotConfig";
import type { BotGameState, Vec3, VisibleProjectile } from "./BotGameState";
import { PHYSICS } from "./BotMovementProfile";

const TICK_RATE = 125;
const MIN_RUN_TICKS = Math.round(0.25 * TICK_RATE);
const MAX_RUN_TICKS = Math.round(0.9 * TICK_RATE);
const STEADY_RUN_TICKS = Math.round(0.6 * TICK_RATE);
const STOP_TICKS = Math.round(0.15 * TICK_RATE);
/** A projectile first seen this close to the bot is its own. */
const OWN_PROJECTILE_RADIUS = 120;

export interface CombatMoves {
  /** −1 left, 0 none, 1 right. */
  strafe: -1 | 0 | 1;
  jump: boolean;
  crouch: boolean;
}

type Skills = Pick<BotDifficulty, "dodgeSkill" | "strafeJumpSkill" | "reactionTimeMs">;

export class BotCombatMovement {
  private _dodgeJumpSent = false;
  private _lastJumpTick = Number.NEGATIVE_INFINITY;
  private _side: -1 | 1 = 1;
  private _runUntil = 0;
  private _stopUntil = 0;
  private _lastHitTick = -1;
  private _dodgeUntil = 0;
  private _dodgeSide: -1 | 1 = 1;
  private _dodgeJump = false;
  private _dodgeCrouch = false;
  /** Projectiles by entity: when first seen, whether they are this bot's own, and whether one was already dodged. */
  private readonly _projectiles = new Map<string, { firstTick: number; own: boolean; handled: boolean }>();

  constructor(private readonly _random: () => number = Math.random) {}

  reset(): void {
    this._dodgeJumpSent = false;
    this._lastJumpTick = Number.NEGATIVE_INFINITY;
    this._runUntil = 0;
    this._stopUntil = 0;
    this._dodgeUntil = 0;
    this._projectiles.clear();
  }

  step(state: BotGameState, skills: Skills, _targetDistance: number): CombatMoves {
    const tick = state.tick;
    const skill = clamp01(skills.dodgeSkill);
    this._trackProjectiles(state);

    this._reactToRocket(state, skills);
    this._reactToHit(state, skill);

    if (tick < this._dodgeUntil) {
      const jump =
        this._dodgeJump && !this._dodgeJumpSent && state.self.isGrounded && tick - this._lastJumpTick >= TICK_RATE;
      if (jump) {
        this._dodgeJumpSent = true;
        this._lastJumpTick = tick;
      }
      return { strafe: this._dodgeSide, jump, crouch: this._dodgeCrouch };
    }

    if (tick >= this._runUntil) this._nextRun(tick, skill);
    const strafe: -1 | 0 | 1 = tick < this._stopUntil ? 0 : this._side;
    return { strafe, jump: false, crouch: false };
  }

  /** The next strafe run: its side, length, and whether it starts with a stop. */
  private _nextRun(tick: number, skill: number): void {
    const doubleBack = this._random() < 0.15 * skill;
    const stop = !doubleBack && this._random() < 0.1 * skill;
    this._side = (this._side * -1) as -1 | 1;
    const varied = MIN_RUN_TICKS + this._random() * (MAX_RUN_TICKS - MIN_RUN_TICKS);
    const steady = STEADY_RUN_TICKS * (0.85 + this._random() * 0.3);
    let length = Math.round(steady + (varied - steady) * skill);
    if (doubleBack) length = STOP_TICKS;
    this._stopUntil = stop ? tick + STOP_TICKS : 0;
    this._runUntil = tick + length + (stop ? STOP_TICKS : 0);
  }

  private _reactToHit(state: BotGameState, skill: number): void {
    const hit = state.recentDamage[state.recentDamage.length - 1];
    if (!hit || hit.tick <= this._lastHitTick) return;
    this._lastHitTick = hit.tick;
    if (state.tick < this._dodgeUntil || !state.self.isGrounded || this._random() >= skill) return;
    const fast = Math.hypot(state.self.velocity.x, state.self.velocity.z) >= PHYSICS.SLIDE_MIN_SPEED;
    const slide = fast && skill >= 0.35 && this._random() < 0.35;
    this._dodge(state.tick, this._random() < 0.5 ? -1 : 1, !slide, slide, slide ? 0.5 : 0.3);
  }

  private _reactToRocket(state: BotGameState, skills: Skills): void {
    if (state.tick < this._dodgeUntil) return;
    const notice = Math.round((skills.reactionTimeMs / 1000) * TICK_RATE);
    for (const projectile of state.projectiles) {
      const seen = this._projectiles.get(projectile.entityId);
      if (!seen || seen.own || seen.handled || !projectile.isThreat) continue;
      if (state.tick - seen.firstTick < notice) continue;
      seen.handled = true;
      if (this._random() >= clamp01(skills.dodgeSkill)) continue;
      const side = awaySide(state.self.position, state.self.yaw, projectile);
      const jump = state.self.isGrounded && this._random() < clamp01(skills.dodgeSkill);
      this._dodge(state.tick, side, jump, false, 0.4);
      return;
    }
  }

  private _dodge(tick: number, side: -1 | 1, jump: boolean, crouch: boolean, seconds: number): void {
    this._dodgeJumpSent = false;
    this._dodgeSide = side;
    this._dodgeJump = jump;
    this._dodgeCrouch = crouch;
    this._dodgeUntil = tick + Math.round(seconds * TICK_RATE);
    this._side = side;
    this._runUntil = this._dodgeUntil + MIN_RUN_TICKS;
  }

  private _trackProjectiles(state: BotGameState): void {
    const alive = new Set<string>();
    for (const projectile of state.projectiles) {
      alive.add(projectile.entityId);
      if (this._projectiles.has(projectile.entityId)) continue;
      const own = distance(projectile.position, state.self.position) <= OWN_PROJECTILE_RADIUS;
      this._projectiles.set(projectile.entityId, { firstTick: state.tick, own, handled: false });
    }
    for (const id of this._projectiles.keys()) if (!alive.has(id)) this._projectiles.delete(id);
  }
}

/** High ground: within this of the bot, at least this much higher, and not further from the enemy than this. */
const HIGH_GROUND_RADIUS = 300;
const HIGH_GROUND_RISE = 64;
const HIGH_GROUND_MAX_RANGE = 900;

/**
 * A nav node near `self`, higher than both it and the enemy, that still sees
 * the enemy: the best one is the highest. Null when there is none.
 */
export function findHighGround(
  nodes: ReadonlyArray<{ position: Vec3 }>,
  self: Vec3,
  enemy: Vec3,
  canSee: (from: Vec3, to: Vec3) => boolean,
): Vec3 | null {
  let best: Vec3 | null = null;
  for (const node of nodes) {
    const p = node.position;
    if (p.y < self.y + HIGH_GROUND_RISE || p.y < enemy.y + HIGH_GROUND_RISE) continue;
    if (best && p.y <= best.y) continue;
    if (Math.hypot(p.x - self.x, p.z - self.z) > HIGH_GROUND_RADIUS) continue;
    if (distance(p, enemy) > HIGH_GROUND_MAX_RANGE) continue;
    if (!canSee({ x: p.x, y: p.y + 40, z: p.z }, enemy)) continue;
    best = p;
  }
  return best;
}

/** Which way to strafe (relative to `yaw`) to step off a projectile's path. */
export function awaySide(self: Vec3, yaw: number, projectile: VisibleProjectile): -1 | 1 {
  // Side of the path the bot is on, in the horizontal plane; step further that way.
  const vx = projectile.velocity.x;
  const vz = projectile.velocity.z;
  const ox = self.x - projectile.position.x;
  const oz = self.z - projectile.position.z;
  const cross = vx * oz - vz * ox;
  // World direction away from the path: perpendicular to the velocity, toward the bot's side.
  const len = Math.hypot(vx, vz) || 1;
  const sign = cross >= 0 ? 1 : -1;
  const awayX = (-vz / len) * sign;
  const awayZ = (vx / len) * sign;
  // Right of the view is (cos yaw, −sin yaw).
  const right = awayX * Math.cos(yaw) - awayZ * Math.sin(yaw);
  return right >= 0 ? 1 : -1;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
