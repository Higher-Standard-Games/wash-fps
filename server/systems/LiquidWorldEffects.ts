/**
 * What a liquid does to you for being in it.
 *
 * Drowning, and the damage lava and slime deal. Pure rules over a per-player
 * timer, so the whole model is testable without a server: the system that owns
 * the tick calls these and applies whatever comes back.
 *
 * Q3's numbers, because they are load-bearing for how a map plays rather than
 * arbitrary. Twelve seconds of air is long enough to cross a flooded passage
 * and short enough that a fight underwater has a clock. Lava at thirty a
 * second per depth level kills a full-health player in about two seconds,
 * which is what makes lava a wall rather than a shortcut.
 */

import type { WaterLevel } from "../../liquid/LiquidTypes";

/** Seconds of air a player has once their head goes under. */
export const AIR_SECONDS = 12;

/**
 * Drowning damage climbs by this each second, starting at one step, so a long
 * hold gets worse rather than settling into a survivable rhythm.
 */
export const DROWN_DAMAGE_STEP = 2;
export const DROWN_DAMAGE_MAX = 15;

/** Damage per second per water level. */
export const LAVA_DAMAGE_PER_LEVEL = 30;
export const SLIME_DAMAGE_PER_LEVEL = 10;

/** How often liquid burns and drowning bites, in seconds. */
export const EFFECT_INTERVAL = 1;

/**
 * Per-player state the rules need between ticks.
 *
 * Deliberately small and plain: the owning system holds one of these per
 * player and hands it back each tick, so nothing here has to know about
 * entities, components, or how a player is stored.
 */
export interface LiquidEffectState {
  /** Seconds of air left. Refilled whenever the head is clear. */
  air: number;
  /** Seconds until the next drowning tick. */
  drownTimer: number;
  /** Escalating drowning damage — resets when the player breathes. */
  drownDamage: number;
  /** Seconds until the next burn from lava or slime. */
  burnTimer: number;
}

export function createLiquidEffectState(): LiquidEffectState {
  return { air: AIR_SECONDS, drownTimer: 0, drownDamage: 0, burnTimer: 0 };
}

export interface LiquidEffectResult {
  /** Damage from having no air. Ignores armor — you cannot armor your lungs. */
  drownDamage: number;
  /** Damage from the liquid itself. */
  burnDamage: number;
  /** True on the tick air runs out, for the gasp. */
  startedDrowning: boolean;
}

const NOTHING: LiquidEffectResult = { drownDamage: 0, burnDamage: 0, startedDrowning: false };

/**
 * Advance one player's liquid effects.
 *
 * `contents` is the raw liquid mask at the feet — both bits may be set, and a
 * brush that is water AND slime burns you while you swim in it, which is what
 * four of the shipped shaders describe.
 */
export function tickLiquidEffects(
  state: LiquidEffectState,
  level: WaterLevel,
  isLava: boolean,
  isSlime: boolean,
  deltaTime: number,
): LiquidEffectResult {
  const burn = tickBurn(state, level, isLava, isSlime, deltaTime);
  const drown = tickDrowning(state, level, deltaTime);

  if (burn === 0 && drown.drownDamage === 0 && !drown.startedDrowning) return NOTHING;
  return { drownDamage: drown.drownDamage, burnDamage: burn, startedDrowning: drown.startedDrowning };
}

function tickBurn(
  state: LiquidEffectState,
  level: WaterLevel,
  isLava: boolean,
  isSlime: boolean,
  deltaTime: number,
): number {
  if (level === 0 || (!isLava && !isSlime)) {
    // Leaving means the next contact burns immediately rather than waiting out
    // a timer the player cannot see.
    state.burnTimer = 0;
    return 0;
  }

  state.burnTimer -= deltaTime;
  if (state.burnTimer > 0) return 0;

  state.burnTimer += EFFECT_INTERVAL;

  // Depth scales it: wading through the edge of a lava pool should hurt, and
  // swimming in it should be over quickly. Both bits stack, because a brush
  // that is both is worse than either.
  let damage = 0;
  if (isLava) damage += LAVA_DAMAGE_PER_LEVEL * level;
  if (isSlime) damage += SLIME_DAMAGE_PER_LEVEL * level;
  return damage;
}

function tickDrowning(
  state: LiquidEffectState,
  level: WaterLevel,
  deltaTime: number,
): { drownDamage: number; startedDrowning: boolean } {
  // Anything short of fully submerged is a breath. Level 2 is chin-deep with
  // the eye probe clear, so a player treading at the surface can breathe.
  if (level < 3) {
    state.air = AIR_SECONDS;
    state.drownTimer = 0;
    state.drownDamage = 0;
    return { drownDamage: 0, startedDrowning: false };
  }

  if (state.air > 0) {
    state.air = Math.max(0, state.air - deltaTime);
    if (state.air > 0) return { drownDamage: 0, startedDrowning: false };
    // Air just ran out. Fall through so the first hit lands on this tick —
    // running out and being hurt should be the same moment, not a second
    // apart with nothing to explain the gap.
    state.drownTimer = 0;
  }

  state.drownTimer -= deltaTime;
  if (state.drownTimer > 0) return { drownDamage: 0, startedDrowning: false };

  const startedDrowning = state.drownDamage === 0;
  state.drownTimer += EFFECT_INTERVAL;
  // Escalating, so holding your breath too long gets worse rather than
  // settling into a survivable rhythm.
  state.drownDamage = Math.min(DROWN_DAMAGE_MAX, state.drownDamage + DROWN_DAMAGE_STEP);

  return { drownDamage: state.drownDamage, startedDrowning };
}

/** Air remaining as a fraction, for a HUD that wants to show it. */
export function airFraction(state: LiquidEffectState): number {
  return Math.max(0, Math.min(1, state.air / AIR_SECONDS));
}
