/**
 * BotWeaponCombos — the weapon a good player switches to before the distance
 * says so.
 *
 * - A rocket that throws the enemy up is followed by an electrobolt at range
 *   or the riotgun close, while they hang in the air.
 * - A rocket hit at arm's length is followed by the blade.
 * - Long plasma pressure is broken by a rail shot now and then.
 * - Before a heard enemy comes into view, the gun for the distance they were
 *   heard at is already out (StateMachineBrain `_readyForHeard`).
 *
 * Each chance is rolled once, at `predictionSkill` odds: about one in five on
 * Easy, nine in ten on Insane.
 */

import type { BotGameState, VisiblePlayer } from "./BotGameState";

const TICK_RATE = 125;
/** A hit this recent still sets up a combo. */
const HIT_FRESH_TICKS = Math.round(0.3 * TICK_RATE);
/** Rising this fast after a rocket hit counts as thrown up. */
const LAUNCH_SPEED = 150;
const BLADE_REACH = 150;
const BOLT_MIN_RANGE = 400;
/** Plasma held this long at rail range invites a rail shot. */
const PLASMA_SPELL_TICKS = Math.round(1.5 * TICK_RATE);
const RAIL_RANGE = 500;

const HOLD = {
  launch: Math.round(0.8 * TICK_RATE),
  blade: Math.round(0.6 * TICK_RATE),
  rail: Math.round(0.7 * TICK_RATE),
};

export type ComboKind = keyof typeof HOLD;

export class BotWeaponCombos {
  private _weapon: string | null = null;
  private _kind: ComboKind | null = null;
  private _until = 0;
  private _targetId: string | null = null;
  private _lastHitTick = -1;
  private _plasmaSince: number | null = null;

  constructor(private readonly _random: () => number = Math.random) {}

  reset(): void {
    this._weapon = null;
    this._kind = null;
    this._until = 0;
    this._plasmaSince = null;
  }

  /** The combo under way, for tests and debugging. */
  get active(): ComboKind | null {
    return this._kind;
  }

  /**
   * The weapon to hold against `enemy` in place of `picked` (the distance
   * choice), or null to keep the pick.
   */
  choose(state: BotGameState, enemy: VisiblePlayer, predictionSkill: number, picked: string): string | null {
    const tick = state.tick;
    if (this._weapon && (tick >= this._until || enemy.playerId !== this._targetId || !has(state, this._weapon))) {
      this._weapon = null;
      this._kind = null;
    }

    this._rocketCombo(state, enemy, predictionSkill);
    if (!this._weapon) this._railBreak(state, enemy, predictionSkill, picked);
    return this._weapon;
  }

  private _rocketCombo(state: BotGameState, enemy: VisiblePlayer, skill: number): void {
    const hit = state.recentHits[state.recentHits.length - 1];
    if (!hit || hit.tick <= this._lastHitTick) return;
    this._lastHitTick = hit.tick;
    if (hit.weaponId !== "rlauncher" || hit.victimEntityId !== enemy.entityId) return;
    if (state.tick - hit.tick > HIT_FRESH_TICKS) return;

    let weapon: string | null = null;
    let kind: ComboKind | null = null;
    if (enemy.distance < BLADE_REACH && has(state, "blade")) {
      weapon = "blade";
      kind = "blade";
    } else if (enemy.velocity.y > LAUNCH_SPEED) {
      weapon = enemy.distance >= BOLT_MIN_RANGE ? "electrobolt" : "riotgun";
      kind = "launch";
      if (!has(state, weapon)) weapon = null;
    }
    if (!weapon || !kind || this._random() >= skill) return;
    this._hold(state.tick, enemy, weapon, kind);
  }

  private _railBreak(state: BotGameState, enemy: VisiblePlayer, skill: number, picked: string): void {
    const plasma = picked === "plasmagun" && state.self.currentWeapon === "plasmagun";
    if (!plasma || enemy.distance < RAIL_RANGE) {
      this._plasmaSince = null;
      return;
    }
    this._plasmaSince ??= state.tick;
    if (state.tick - this._plasmaSince < PLASMA_SPELL_TICKS) return;
    this._plasmaSince = state.tick + HOLD.rail;
    if (!has(state, "electrobolt") || this._random() >= skill) return;
    this._hold(state.tick, enemy, "electrobolt", "rail");
  }

  private _hold(tick: number, enemy: VisiblePlayer, weapon: string, kind: ComboKind): void {
    this._weapon = weapon;
    this._kind = kind;
    this._targetId = enemy.playerId;
    this._until = tick + HOLD[kind];
  }
}

/** Whether the bot carries `weapon` with ammo for it. */
export function has(state: BotGameState, weapon: string): boolean {
  if (!state.self.weapons.includes(weapon)) return false;
  const ammo = state.self.ammo[weapon];
  return ammo === undefined || ammo > 0;
}

/** The 1-based slot of `weapon`, or 0 when it is already out or not carried. */
export function slotFor(state: BotGameState, weapon: string): number {
  if (state.self.currentWeapon === weapon) return 0;
  const index = state.self.weapons.indexOf(weapon);
  return index < 0 ? 0 : index + 1;
}
