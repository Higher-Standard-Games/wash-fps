/**
 * BotWeaponCombos — the weapon a good player switches to before the distance
 * says so.
 *
 * - A rocket that throws the enemy up is followed by an electrobolt at range
 *   or the riotgun close, while they hang in the air.
 * - A rocket hit at arm's length is followed by the blade.
 * - Long plasma pressure is broken by a rail shot now and then.
 * - A slow gun just fired is swapped for the other gun carried while it
 *   reloads, when that one fits the distance and can shoot well before the
 *   slow one could again: a bolt then the machinegun, a rocket then the
 *   riotgun. The server keeps one refire clock across a switch, timed by the
 *   gun in hand, so the swap buys shots.
 * - Before a heard enemy comes into view, the gun for the distance they were
 *   heard at is already out (StateMachineBrain `_readyForHeard`).
 * - An enemy the bot's fresh estimate says one hit would kill (MatchRead: the
 *   hits it landed, the pain it heard) is finished with the hitscan gun that
 *   does it at this distance, as a player switches to the sure kill.
 *
 * Each chance is rolled once, at `predictionSkill` odds: about one in five on
 * Easy, nine in ten on Insane.
 */

import { DEFAULT_PHYSICS_TICK_RATE as TICK_RATE } from "../../../shared/server/simulation/physics/constants";
import type { BotGameState, VisiblePlayer } from "./BotGameState";
import { getWeaponProfile } from "./BotWeaponProfile";
import { ARMOR_ABSORPTION } from "./strategy/MatchRead";

/** What `choose` needs of an enemy estimate (MatchRead). */
export interface EnemyEstimateLike {
  health: number;
  armor: number;
  uncertainty: number;
}

/** A hit this recent still sets up a combo. */
const HIT_FRESH_TICKS = Math.round(0.3 * TICK_RATE);
/** Rising this fast after a rocket hit counts as thrown up. */
const LAUNCH_SPEED = 150;
const BLADE_REACH = 150;
const BOLT_MIN_RANGE = 400;
/** Plasma held this long at rail range invites a rail shot. */
const PLASMA_SPELL_TICKS = Math.round(1.5 * TICK_RATE);
const RAIL_RANGE = 500;
/** A swap after a shot must let the other gun fire at least this much sooner. */
const REFIRE_MIN_GAIN_TICKS = Math.round(0.25 * TICK_RATE);
/** From the decision to swap until the server has the other gun out. */
const SWAP_TICKS = 4;
/** A gun swapped in fits the distance this far outside its ideal range. */
const SWAP_RANGE_SLACK = 0.25;

/** An estimate this unsure is not acted on (MatchRead uncertainty). */
const FINISH_MAX_UNCERTAINTY = 0.3;
/** Share of a multi-pellet shot counted on to land. */
const PELLETS_LANDING = 0.5;

const HOLD = {
  finish: Math.round(0.8 * TICK_RATE),
  launch: Math.round(0.8 * TICK_RATE),
  blade: Math.round(0.6 * TICK_RATE),
  rail: Math.round(0.7 * TICK_RATE),
  /** Set per swap: until the gun just fired is ready again. */
  refire: 0,
};

export type ComboKind = keyof typeof HOLD;

export class BotWeaponCombos {
  private _weapon: string | null = null;
  private _kind: ComboKind | null = null;
  private _until = 0;
  private _targetId: string | null = null;
  private _lastHitTick = -1;
  private _plasmaSince: number | null = null;
  private _lastShotTick = -1;
  /** The estimate the finish was last rolled for. */
  private _finishRolled: string | null = null;

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
  choose(
    state: BotGameState,
    enemy: VisiblePlayer,
    predictionSkill: number,
    picked: string,
    estimate?: EnemyEstimateLike | null,
  ): string | null {
    const tick = state.tick;
    if (this._weapon && (tick >= this._until || enemy.playerId !== this._targetId || !has(state, this._weapon))) {
      this._weapon = null;
      this._kind = null;
    }

    if (estimate) this._finish(state, enemy, predictionSkill, estimate);
    if (!this._weapon) this._rocketCombo(state, enemy, predictionSkill);
    if (!this._weapon) this._railBreak(state, enemy, predictionSkill, picked);
    if (!this._weapon) this._refireSwap(state, enemy, predictionSkill);
    return this._weapon;
  }

  /** Rolled once per change in the estimate: the hitscan gun whose one hit kills. */
  private _finish(state: BotGameState, enemy: VisiblePlayer, skill: number, estimate: EnemyEstimateLike): void {
    if (estimate.uncertainty > FINISH_MAX_UNCERTAINTY) return;
    const key = `${enemy.playerId}:${Math.round(estimate.health)}:${Math.round(estimate.armor)}`;
    if (key === this._finishRolled) return;
    this._finishRolled = key;
    let best: string | null = null;
    let bestDamage = Number.POSITIVE_INFINITY;
    for (const weapon of state.self.weapons) {
      if (!has(state, weapon)) continue;
      const profile = getWeaponProfile(weapon);
      if (!profile.isHitscan || profile.isMelee) continue;
      if (enemy.distance > profile.idealMaxRange * (1 + SWAP_RANGE_SLACK)) continue;
      const hit = profile.damagePerHit * (profile.pelletCount > 1 ? PELLETS_LANDING : 1);
      const toHealth = hit - Math.min(estimate.armor, hit * ARMOR_ABSORPTION);
      // The smallest hit that still kills, so the big gun stays for the next fight.
      if (toHealth >= estimate.health && hit < bestDamage) {
        best = weapon;
        bestDamage = hit;
      }
    }
    if (!best || this._random() >= skill) return;
    this._hold(state.tick, enemy, best, "finish");
  }

  /** Rolled once per shot of the gun in hand. */
  private _refireSwap(state: BotGameState, enemy: VisiblePlayer, skill: number): void {
    const shot = state.lastOwnShot;
    if (!shot || shot.tick <= this._lastShotTick) return;
    this._lastShotTick = shot.tick;
    if (shot.weaponId !== state.self.currentWeapon) return;

    const readyAgain = shot.tick + getWeaponProfile(shot.weaponId).fireIntervalTicks;
    const out = state.tick + SWAP_TICKS;
    let best: string | null = null;
    let bestDps = 0;
    for (const weapon of state.self.weapons) {
      if (weapon === shot.weaponId || !has(state, weapon)) continue;
      const profile = getWeaponProfile(weapon);
      const fits = profile.isMelee
        ? enemy.distance < BLADE_REACH
        : enemy.distance >= profile.idealMinRange * (1 - SWAP_RANGE_SLACK) &&
          enemy.distance <= profile.idealMaxRange * (1 + SWAP_RANGE_SLACK);
      const ready = Math.max(shot.tick + profile.fireIntervalTicks, out);
      if (fits && readyAgain - ready >= REFIRE_MIN_GAIN_TICKS && profile.dps > bestDps) {
        best = weapon;
        bestDps = profile.dps;
      }
    }
    if (!best || this._random() >= skill) return;
    this._hold(state.tick, enemy, best, "refire", readyAgain - state.tick);
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

  private _hold(tick: number, enemy: VisiblePlayer, weapon: string, kind: ComboKind, ticks = HOLD[kind]): void {
    this._weapon = weapon;
    this._kind = kind;
    this._targetId = enemy.playerId;
    this._until = tick + ticks;
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
