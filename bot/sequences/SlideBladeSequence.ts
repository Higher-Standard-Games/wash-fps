import type { BotInput } from "../BotBrain";
import { InputButtons } from "../BotConfig";
import type { Vec3, VisiblePlayer } from "../BotGameState";
import { PHYSICS } from "../BotMovementProfile";
import type { BotSequence, BotSequenceContext, BotSequenceState, BotSequenceTick } from "../BotSequence";

/** Lunge range: close enough for one slide to reach, too far to just walk up and swing. */
export const LUNGE_MIN_DISTANCE = 200;
export const LUNGE_MAX_DISTANCE = 450;
/** The enemy must be this close to the way the bot is already moving. */
const LUNGE_MAX_HEADING_OFF = (30 * Math.PI) / 180;
/** Not up a step the slide cannot climb. */
const LUNGE_MAX_RISE = 64;
/** Blade reach plus its dash: swing from here. */
const STRIKE_DISTANCE = 160;
/** How long the swing is held. */
const STRIKE_TICKS = 20;
/** How long the jump out of a missed lunge is held. */
const EXIT_TICKS = 12;
/** Give up if the slide has not started by now. */
const SLIDE_CONFIRM_TICKS = 25;
const BLADE = "blade";

function horizontalSpeed(v: Vec3): number {
  return Math.hypot(v.x, v.z);
}

function bladeSlot(weapons: readonly string[]): number {
  const index = weapons.indexOf(BLADE);
  return index < 0 ? 0 : index + 1;
}

function slotOf(weapons: readonly string[], weaponId: string): number {
  const index = weapons.indexOf(weaponId);
  return index < 0 ? 0 : index + 1;
}

/** Whether the bot is set up for a lunge at `target`; the brain adds cooldowns and odds. */
export function canLunge(context: BotSequenceContext, target: VisiblePlayer): boolean {
  const self = context.state.self;
  if (!self.isGrounded || self.isSliding || self.isDead || target.isDead) return false;
  if (bladeSlot(self.weapons) === 0) return false;
  const speed = horizontalSpeed(self.velocity);
  if (speed < PHYSICS.SLIDE_MIN_SPEED) return false;
  const dx = target.position.x - self.position.x;
  const dz = target.position.z - self.position.z;
  const distance = Math.hypot(dx, dz);
  if (distance < LUNGE_MIN_DISTANCE || distance > LUNGE_MAX_DISTANCE) return false;
  if (target.position.y - self.position.y > LUNGE_MAX_RISE) return false;
  const heading = Math.atan2(self.velocity.x, self.velocity.z);
  const off = Math.atan2(dx, dz) - heading;
  if (Math.abs(Math.atan2(Math.sin(off), Math.cos(off))) > LUNGE_MAX_HEADING_OFF) return false;
  // A clear, floored lane: no sliding off a ledge or into a wall.
  return context.vision?.isWalkable(self.position, target.position) ?? false;
}

/**
 * Close 200–450 units in one crouch-slide with the blade out and swing on
 * arrival. A miss jumps out of the slide sideways and goes back to the gun.
 */
export class SlideBladeSequence implements BotSequence {
  readonly id = "combat_slide_blade";
  readonly tags = ["combat", "movement", "crouchslide", "melee"] as const;
  readonly maxTicks = 180;

  score(context: BotSequenceContext): number | null {
    const target = context.combatTarget;
    return target && canLunge(context, target) ? 900 : null;
  }

  start(context: BotSequenceContext): BotSequenceState {
    const target = context.combatTarget;
    if (!target) throw new Error("SlideBladeSequence requires a combat target");
    return {
      phase: "slide",
      startedTick: context.state.tick,
      phaseStartedTick: context.state.tick,
      commitUntilTick: context.state.tick + SLIDE_CONFIRM_TICKS,
      data: {
        targetId: target.playerId,
        previousWeapon: context.state.self.currentWeapon,
        wasSliding: false,
        strikeTick: null,
        exitTick: null,
        exitReason: null,
        side: Math.random() < 0.5 ? -1 : 1,
      },
    };
  }

  tick(context: BotSequenceContext, state: BotSequenceState): BotSequenceTick {
    const self = context.state.self;
    if (state.data.exitTick !== null) return this._exit(context, state);
    const target = context.state.players.find((p) => p.playerId === state.data.targetId && !p.isDead);
    if (!target) return this._exit(context, state, "target_lost");

    // Aim the run, and the swing, where the target will be on arrival.
    const speed = Math.max(PHYSICS.SLIDE_MIN_SPEED, horizontalSpeed(self.velocity));
    const distance = Math.hypot(target.position.x - self.position.x, target.position.z - self.position.z);
    const lead = (context.difficulty?.predictionSkill ?? 0.5) * (distance / speed);
    const aimAt = {
      x: target.position.x + target.velocity.x * lead,
      y: target.position.y,
      z: target.position.z + target.velocity.z * lead,
    };
    const yaw = Math.atan2(aimAt.x - self.position.x, aimAt.z - self.position.z);
    const pitch = -Math.atan2(aimAt.y - self.position.y, Math.max(1, distance));
    const blade = bladeSlot(self.weapons);
    const move = (buttons: number): BotInput => ({
      direction: { x: 0, y: 0, z: 1 },
      pitch,
      yaw,
      buttons,
      weaponSlot: blade,
    });

    if (self.isSliding) state.data.wasSliding = true;
    const strikeTick = state.data.strikeTick as number | null;

    if (strikeTick !== null) {
      if (context.state.tick - strikeTick >= STRIKE_TICKS) {
        return { input: move(InputButtons.FORWARD), status: "succeeded", phase: "strike" };
      }
      return { input: move(InputButtons.FORWARD | InputButtons.FIRE), status: "running", phase: "strike" };
    }

    if (distance <= STRIKE_DISTANCE && self.currentWeapon === BLADE) {
      state.data.strikeTick = context.state.tick;
      return {
        input: move(InputButtons.FORWARD | InputButtons.CROUCH | InputButtons.FIRE),
        status: "running",
        phase: "strike",
        commitForTicks: STRIKE_TICKS,
      };
    }

    if (state.data.wasSliding === true && !self.isSliding) return this._exit(context, state, "missed");
    if (state.data.wasSliding !== true && context.state.tick - state.startedTick >= SLIDE_CONFIRM_TICKS) {
      return this._exit(context, state, "slide_not_confirmed");
    }

    return {
      input: move(InputButtons.FORWARD | InputButtons.SPRINT | InputButtons.CROUCH),
      status: "running",
      phase: "slide",
    };
  }

  /** Jump out sideways for a moment and take the gun back out; then the lunge has failed. */
  private _exit(context: BotSequenceContext, state: BotSequenceState, reason?: string): BotSequenceTick {
    const self = context.state.self;
    if (state.data.exitTick === null) {
      state.data.exitTick = context.state.tick;
      state.data.exitReason = reason ?? "failed";
    }
    const done = context.state.tick - (state.data.exitTick as number) >= EXIT_TICKS;
    const side = state.data.side as -1 | 1;
    const previous = state.data.previousWeapon as string;
    return {
      input: {
        direction: { x: side, y: 0, z: 0.5 },
        pitch: self.pitch,
        yaw: self.yaw,
        buttons: InputButtons.JUMP | (side < 0 ? InputButtons.LEFT : InputButtons.RIGHT),
        weaponSlot: previous && previous !== BLADE ? slotOf(self.weapons, previous) : 0,
      },
      status: done ? "failed" : "running",
      phase: "exit",
      reason: done ? (state.data.exitReason as string) : undefined,
      commitForTicks: done ? undefined : EXIT_TICKS,
    };
  }
}
