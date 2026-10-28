/**
 * HintCoach — decides when a hint for a new player is worth showing.
 *
 * It watches the local player's movement, their state (health, armor, the
 * weapon in hand, water, the bomb) and a few events (shots, fall damage, an
 * emptied clip), and offers a hint when the player is in the situation the
 * hint is about. A different hint replaces the one on screen at once; the
 * same hint shows at most once a minute, and a few only once.
 */

import { DEFAULT_FPS_MOVEMENT_CONFIG } from "../../simulation/MovementProfile";

export type HintId =
  | "slide"
  | "aim"
  | "walljump"
  | "bunnyhop"
  | "slidespeed"
  | "strafe"
  | "ledge"
  | "fall"
  | "health"
  | "armor"
  | "shock"
  | "air"
  | "switch"
  | "blade"
  | "rocketjump"
  | "grenade"
  | "reload"
  | "scoreboard"
  | "plant"
  | "defuse";

/** The local player's movement, from a predicted movement step. */
export interface MovementSample {
  grounded: boolean;
  sliding: boolean;
  /** Horizontal speed, units/s */
  horizontalSpeed: number;
  /** Vertical speed, units/s, up positive */
  verticalSpeed: number;
  wallJump: "none" | "available" | "charging";
  ledgeGrab?: "none" | "grabbing" | "pulling";
  /** Forward held, and either strafe key held */
  forward?: boolean;
  strafing?: boolean;
}

/** The local player's state, from the HUD. */
export interface StatusSample {
  health: number;
  armor: number;
  /** Milliseconds since the live match began, or null in warmup */
  liveForMs: number | null;
  /** The weapon in hand, and whether a gun other than the blade is carried */
  weapon: string;
  carriesGun: boolean;
  grounded: boolean;
  /** 0 dry, 1 wading, 2 swimming, 3 under */
  waterLevel: number;
  /** Air left, 0-1 */
  air: number;
  /** Carrying the bomb; defending a planted bomb */
  carriesBomb: boolean;
  defendingPlantedBomb: boolean;
}

/** Horizontal speed at which crouching starts a slide. */
export const SLIDE_SPEED = DEFAULT_FPS_MOVEMENT_CONFIG.slideMinSpeed;
/** How long a player runs that fast without sliding before the slide hint (ms). */
const FAST_RUN_MS = 300;
/** Jumps within this window make a hop chain (ms). */
const HOP_WINDOW_MS = 2000;
/** Three jumps within this window are jumping in a row: time to try a wall (ms). */
const JUMP_RUN_MS = 3000;
/** Upward speed that makes leaving the ground a jump rather than a step off (units/s). */
const JUMP_SPEED = 150;
/** How long fire is held from the hip before the aim hint (ms). */
const HIP_HOLD_MS = 1000;
/** Health under this, for HURT_MS, is hurt enough to look for health. */
const HURT_HEALTH = 50;
const HURT_MS = 3000;
/** Time in a live match without armor before the armor hint (ms). */
const NO_ARMOR_MS = 15_000;
/** Air left under this is running out. */
const LOW_AIR = 0.5;
/** Weapons that shock their holder in water, and the depth they do it at. */
const SHOCK_WEAPONS = new Set(["voltaic", "electrobolt"]);
const SHOCK_WATER_LEVEL = 2;
/** The blade held this long with a gun carried: time to switch (ms). */
const BLADE_WITH_GUN_MS = 8000;
/** The blade held this long without a charged blast (ms). */
const BLADE_UNCHARGED_MS = 12_000;
/** The rocket launcher held on the ground this long, in all (ms). */
const ROCKET_GROUND_MS = 10_000;
/** Into a live match this long, the scoreboard hint (ms). */
const SCOREBOARD_AFTER_MS = 20_000;
/** Carrying the bomb this long (ms). */
const CARRY_BOMB_MS = 3000;
/** How long a hint stays on screen before it fades (ms). */
export const HINT_SHOW_MS = 4_500;
/** Least time before the same hint shows again (ms). */
export const HINT_REPEAT_MS = 60_000;
/** Hints that show only once in a session. */
const ONCE: ReadonlySet<HintId> = new Set(["scoreboard", "grenade"]);

export class HintCoach {
  private readonly lastShown: Partial<Record<HintId, number>> = {};
  private previous: MovementSample | null = null;
  private fastSince: number | null = null;
  private jumps: number[] = [];
  /** Whether the current time in the air has been forward-only (no strafe) */
  private airForwardOnly = false;
  private lastAirForwardOnly = false;
  private hipHoldSince: number | null = null;
  /** When each held condition began, by name */
  private readonly since = new Map<string, number>();
  private rocketGroundMs = 0;
  private lastStatusAt: number | null = null;
  private lastChargeAt = -Infinity;
  private bladeSince: number | null = null;

  constructor(private readonly random: () => number = Math.random) {}

  /** Take one movement sample; returns a hint to show now, if one is due. */
  observe(sample: MovementSample, now: number): HintId | null {
    const before = this.previous;
    this.previous = { ...sample };
    if (before?.grounded && !sample.grounded && sample.verticalSpeed > JUMP_SPEED) {
      this.jumps.push(now);
      this.lastAirForwardOnly = this.airForwardOnly;
      this.airForwardOnly = !!sample.forward;
    }
    if (!sample.grounded && (sample.strafing || !sample.forward)) this.airForwardOnly = false;
    this.jumps = this.jumps.filter((at) => now - at <= JUMP_RUN_MS);

    if (sample.ledgeGrab === "grabbing" && before?.ledgeGrab !== "grabbing" && this.offer("ledge", now)) return "ledge";

    // Running fast enough to slide, on the ground, not sliding
    if (sample.grounded && !sample.sliding && sample.horizontalSpeed >= SLIDE_SPEED) this.fastSince ??= now;
    else this.fastSince = null;

    if (this.fastSince !== null && now - this.fastSince >= FAST_RUN_MS && this.offer("slide", now)) return "slide";
    if ((sample.wallJump === "available" || this.jumps.length >= 3) && this.offer("walljump", now)) return "walljump";
    if (this.jumps.filter((at) => now - at <= HOP_WINDOW_MS).length >= 2) {
      // Hopping with forward alone gains nothing: strafing is the lesson
      if (this.lastAirForwardOnly && this.offer("strafe", now)) return "strafe";
      const pick: HintId = this.random() < 0.5 ? "bunnyhop" : "slidespeed";
      const other: HintId = pick === "bunnyhop" ? "slidespeed" : "bunnyhop";
      if (this.offer(pick, now)) return pick;
      if (this.offer(other, now)) return other;
    }
    return null;
  }

  /** Take the player's state from the HUD; returns a hint to show now, if one is due. */
  status(s: StatusSample, now: number): HintId | null {
    const dt = this.lastStatusAt === null ? 0 : Math.min(1000, now - this.lastStatusAt);
    this.lastStatusAt = now;

    if (s.weapon === "rlauncher" && s.grounded) this.rocketGroundMs += dt;
    if (s.weapon === "blade") this.bladeSince ??= now;
    else this.bladeSince = null;

    const candidates: [HintId, boolean][] = [
      ["shock", SHOCK_WEAPONS.has(s.weapon) && s.waterLevel >= SHOCK_WATER_LEVEL],
      ["air", s.air < LOW_AIR],
      ["health", this.held("hurt", s.health > 0 && s.health < HURT_HEALTH, now, HURT_MS)],
      ["armor", this.held("unarmored", s.liveForMs !== null && s.armor <= 0, now, NO_ARMOR_MS)],
      ["plant", this.held("bomb", s.carriesBomb, now, CARRY_BOMB_MS)],
      ["defuse", s.defendingPlantedBomb],
      ["switch", this.held("blade-with-gun", s.weapon === "blade" && s.carriesGun, now, BLADE_WITH_GUN_MS)],
      ["blade", this.bladeSince !== null && now - Math.max(this.bladeSince, this.lastChargeAt) >= BLADE_UNCHARGED_MS],
      ["rocketjump", this.rocketGroundMs >= ROCKET_GROUND_MS],
      ["grenade", s.weapon === "glauncher"],
      ["scoreboard", s.liveForMs !== null && s.liveForMs >= SCOREBOARD_AFTER_MS],
    ];
    for (const [id, due] of candidates) {
      if (!due || !this.offer(id, now)) continue;
      if (id === "rocketjump") this.rocketGroundMs = 0;
      return id;
    }
    return null;
  }

  /** The local player fired; returns the aim hint for a hip shot with a weapon that can aim. */
  shot(now: number, fromHip: boolean, canAim: boolean): HintId | null {
    return fromHip && canAim && this.offer("aim", now) ? "aim" : null;
  }

  /**
   * Whether the local player is holding fire from the hip with a weapon that
   * can aim; returns the aim hint once they have held it a second.
   */
  holdingFire(now: number, fromHip: boolean): HintId | null {
    if (!fromHip) {
      this.hipHoldSince = null;
      return null;
    }
    this.hipHoldSince ??= now;
    return now - this.hipHoldSince >= HIP_HOLD_MS && this.offer("aim", now) ? "aim" : null;
  }

  /** The local player took fall damage; returns the hint to land crouched, if it is due. */
  fell(now: number): HintId | null {
    return this.offer("fall", now) ? "fall" : null;
  }

  /** The local player's clip ran dry with ammo in reserve; returns the reload hint, if due. */
  clipEmptied(now: number): HintId | null {
    return this.offer("reload", now) ? "reload" : null;
  }

  /** The local player charged a blast: the blade hint waits again. */
  charged(now: number): void {
    this.lastChargeAt = now;
  }

  /** Whether a condition has held for at least `ms`. */
  private held(name: string, holding: boolean, now: number, ms: number): boolean {
    if (!holding) {
      this.since.delete(name);
      return false;
    }
    if (!this.since.has(name)) this.since.set(name, now);
    return now - this.since.get(name)! >= ms;
  }

  /** Show this hint now unless it has shown lately (or, for a few, at all). */
  private offer(id: HintId, now: number): boolean {
    const last = this.lastShown[id];
    if (last !== undefined && (ONCE.has(id) || now - last < HINT_REPEAT_MS)) return false;
    this.lastShown[id] = now;
    return true;
  }
}
