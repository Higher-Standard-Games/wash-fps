/**
 * Where a roaming bot looks: glances toward open space and at major items'
 * spots while it runs, and the calm look down at the floor ahead. These turn
 * the view and leave movement on its heading. What this needs of the brain
 * comes through LookHost.
 */

import { DEFAULT_PHYSICS_TICK_RATE as TICK_RATE } from "../../../../shared/server/simulation/physics/constants";
import { wrapAngle } from "../BotAimController";
import type { BotInput } from "../BotBrain";
import { BotState, travelYaw } from "../BotBrain";
import { InputButtons } from "../BotConfig";
import type { BotGameState, Vec3 } from "../BotGameState";
import { vec3Distance } from "../BotGameState";
import type { BotLife } from "../BotLife";
import type { BotVision, VisionResult } from "../BotVision";
import { isMajorItem } from "../goals/considerations/ItemFacts";

/** Calm, the view rests this far below where the brain looks: people look at the floor ahead. */
const CALM_PITCH = (10 * Math.PI) / 180;
/** Calm, the view never looks further down than this. */
const CALM_MAX_PITCH = (45 * Math.PI) / 180;
/** Sight lines are scored out to this far, units. */
const LOOK_RANGE = 1500;
/** Rays this far up count too, so stairs ahead are not a wall. */
const LOOK_UP_PITCH = (10 * Math.PI) / 180;

/** Yaw from `from` toward `to`, as the view measures it. */
function bearingTo(from: Vec3, to: Vec3): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}
/** How long a glance holds, ticks (±30%). */
const GLANCE_TICKS = 85;
/** Rest between glances, ticks (from 0.67 to 1.33 of it). */
const GLANCE_REST_TICKS = 375;
/** How open the view is toward `yaw` from `eye`: 1 when nothing is within LOOK_RANGE. */
function openFraction(vision: BotVision, eye: Vec3, yaw: number): number {
  let best = 0;
  for (const pitch of [0, LOOK_UP_PITCH]) {
    const reach = LOOK_RANGE * Math.cos(pitch);
    const end = {
      x: eye.x + Math.sin(yaw) * reach,
      y: eye.y + LOOK_RANGE * Math.sin(pitch),
      z: eye.z + Math.cos(yaw) * reach,
    };
    best = Math.max(best, vision.collisionWorld.trace(eye, end).fraction);
  }
  return best;
}
/** What looking the full LOOK_MAX_OFF_TRAVEL aside costs, of a score out of 1. */
const LOOK_OFF_COST = 0.3;
/** Furthest the view turns from where the bot runs to look into open space. */
const LOOK_MAX_OFF_TRAVEL = (45 * Math.PI) / 180;
/** What turning the view a quarter turn from where it is costs, of a score out of 1. */
const LOOK_TURN_COST = 0.3;
/** How much more open another direction must be to take over. */
const LOOK_SWITCH_MARGIN = 0.2;
const LOOK_STEP = (15 * Math.PI) / 180;
/** With nothing worth a glance, how soon to look for one again, ticks. */
const LOOK_INTERVAL_TICKS = 50;
/** A major item's spot unseen this long is worth a look in passing, ticks. */
const SPOT_STALE_TICKS = 8 * TICK_RATE;
/** Spots are looked at from this far to as far as perception tells them apart (BotPerception). */
const SPOT_MIN_DISTANCE = 200;
const SPOT_MAX_DISTANCE = 2000;

/** What the look needs of the brain. */
export interface LookHost {
  readonly life: BotLife;
  readonly currentState: BotState;
  /** A traversal sequence is running. */
  readonly sequenceActive: boolean;
  readonly visionResult: VisionResult | null;
  /** Habits switched off for head-to-head tests. */
  readonly fightOff: ReadonlySet<string>;
}

export class BotLook {
  constructor(private readonly host: LookHost) {}

  /** When a look at each major item's spot was last begun, by pickup id. */
  readonly spotLooks = new Map<number, number>();

  /** Calm (see `isCalm`), the view rests a little below where the brain looks. */
  calm(state: BotGameState, input: BotInput): void {
    if (!this.isCalm(state, input)) return;
    input.calm = true;
    // People look a little down while running, at the floor ahead (BS-1: 11°).
    input.pitch = Math.min(CALM_MAX_PITCH, input.pitch + CALM_PITCH);
  }

  /** Roaming with no enemy in sight and no scripted move: see `BotInput.calm`. */
  isCalm(state: BotGameState, input: BotInput): boolean {
    if (state.self.isDead || input.script || this.host.sequenceActive) return false;
    if ((input.buttons & (InputButtons.FIRE | InputButtons.ALT_FIRE)) !== 0) return false;
    if ((this.host.visionResult?.visibleEnemies.length ?? 0) > 0) return false;
    // A chase with the enemy out of sight turns toward where they were: a memory, not a sight.
    return (
      this.host.currentState === BotState.ITEM_RUN ||
      this.host.currentState === BotState.HUNT ||
      this.host.currentState === BotState.CHASE ||
      this.host.currentState === BotState.RETREAT ||
      this.host.currentState === BotState.IDLE
    );
  }

  /**
   * Running out of a fight, glance now and then toward the most open
   * direction near where it looks: a sight line down a hall rather than the
   * wall a route corner points at. Between glances the view rests where the
   * bot runs, as a player's does: recorded people have the view more than 20°
   * off their movement 38% of the time running, and bots that held the most
   * open direction all the time 55% (docs/research/BOT_STRATEGY_LAYER.md).
   * A glance lasts GLANCE_TICKS and comes every GLANCE_REST_TICKS or so, when
   * a direction is clearly more open than straight ahead. Movement keeps its
   * heading; the view stays within a quarter turn of it.
   */
  lookIntoOpenSpace(state: BotGameState, input: BotInput, vision: BotVision): void {
    const roaming =
      this.host.currentState === BotState.HUNT ||
      this.host.currentState === BotState.ITEM_RUN ||
      this.host.currentState === BotState.RETREAT;
    if (!roaming) {
      this.host.life.look = null;
      return;
    }
    // Not while firing or standing, nor in a scripted move; a hop or slide keeps the look.
    const running =
      (input.buttons & InputButtons.FORWARD) !== 0 &&
      (input.buttons & (InputButtons.FIRE | InputButtons.ALT_FIRE)) === 0 &&
      input.direction.x === 0 &&
      input.direction.z > 0;
    if (!running || this.host.sequenceActive) return;
    const travel = travelYaw(input);
    const base = input.yaw;
    const allowed = (off: number) => Math.abs(wrapAngle(base + off - travel)) <= Math.PI / 2;
    const spot = this.host.life.look?.spot;
    if (this.host.life.look && spot) {
      // A look at an item's spot follows it, and ends once perception has seen it.
      this.host.life.look.off = wrapAngle(bearingTo(state.self.position, spot.position) - base);
      if ((state.itemSpotSeenTick.get(spot.pickupId) ?? -1) >= spot.sinceTick)
        this.host.life.look.untilTick = state.tick;
    }
    if (!this.host.life.look || this.host.life.look.off === 0) {
      const check = this.host.fightOff.has("itemcheck") ? null : this.spotToCheck(state, base, allowed, vision);
      if (check) {
        this.spotLooks.set(check.pickupId, state.tick);
        this.host.life.look = {
          off: wrapAngle(bearingTo(state.self.position, check.position) - base),
          untilTick: state.tick + GLANCE_TICKS,
          spot: { ...check, sinceTick: state.tick },
        };
      }
    }
    if (
      this.host.life.look &&
      this.host.life.look.off !== 0 &&
      (state.tick >= this.host.life.look.untilTick || !allowed(this.host.life.look.off))
    ) {
      // A glance ends: back to where the bot runs, for a rest of 2–4 s.
      this.host.life.look = { off: 0, untilTick: state.tick + GLANCE_REST_TICKS * (0.67 + 0.67 * Math.random()) };
    }
    if (!this.host.life.look || state.tick >= this.host.life.look.untilTick) {
      const eye = { x: state.self.position.x, y: state.self.position.y + 36, z: state.self.position.z };
      // Turning from where the view is costs too: a route corner moves the
      // way the bot runs, and choosing afresh from it swung the view across.
      const score = (off: number) => {
        const yaw = base + off;
        return (
          openFraction(vision, eye, yaw) -
          (LOOK_OFF_COST * Math.abs(off)) / LOOK_MAX_OFF_TRAVEL -
          (LOOK_TURN_COST * Math.abs(wrapAngle(yaw - state.self.yaw))) / (Math.PI / 2)
        );
      };
      let bestOff = 0;
      let bestScore = score(0) + LOOK_SWITCH_MARGIN;
      for (let off = -LOOK_MAX_OFF_TRAVEL; off <= LOOK_MAX_OFF_TRAVEL + 1e-9; off += LOOK_STEP) {
        if (Math.abs(off) < 1e-9 || !allowed(off)) continue;
        const value = score(off);
        if (value > bestScore) {
          bestScore = value;
          bestOff = off;
        }
      }
      // Nothing worth a glance: look again in a moment.
      this.host.life.look = {
        off: bestOff,
        untilTick: state.tick + (bestOff === 0 ? LOOK_INTERVAL_TICKS : GLANCE_TICKS * (0.7 + 0.6 * Math.random())),
      };
    }
    input.moveYaw = travel;
    input.yaw = base + this.host.life.look.off;
  }

  /**
   * A major item's spot to look at in passing, as a player checks the Red
   * Armor: one not seen for SPOT_STALE_TICKS, in sight from here and within a
   * quarter turn of where the bot runs, the longest unseen first. Seeing it
   * there or gone is what dates its next return.
   */
  spotToCheck(
    state: BotGameState,
    base: number,
    allowed: (off: number) => boolean,
    vision: BotVision,
  ): { pickupId: number; position: Vec3 } | null {
    const self = state.self.position;
    let best: { pickupId: number; position: Vec3 } | null = null;
    let bestSeen = Number.POSITIVE_INFINITY;
    // A vision with no map knowledge (a stand-in) has no spots to look at.
    for (const entry of vision.mapKnowledge?.pickupPositions ?? []) {
      if (!isMajorItem(entry.type, entry.kind)) continue;
      const seen = state.itemSpotSeenTick.get(entry.id) ?? Number.NEGATIVE_INFINITY;
      if (state.tick - seen < SPOT_STALE_TICKS || seen >= bestSeen) continue;
      if (state.tick - (this.spotLooks.get(entry.id) ?? Number.NEGATIVE_INFINITY) < SPOT_STALE_TICKS) continue;
      const distance = vec3Distance(self, entry.position);
      if (distance < SPOT_MIN_DISTANCE || distance > SPOT_MAX_DISTANCE) continue;
      if (!allowed(wrapAngle(bearingTo(self, entry.position) - base))) continue;
      const lift = { x: entry.position.x, y: entry.position.y - 24, z: entry.position.z };
      if (!vision.canSeeFrom(self, lift)) continue;
      best = { pickupId: entry.id, position: entry.position };
      bestSeen = seen;
    }
    return best;
  }
}
