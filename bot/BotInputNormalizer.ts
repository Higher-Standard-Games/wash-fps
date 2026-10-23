/**
 * BotInputNormalizer — Bridge between game state and neural network inputs
 *
 * Combines BotGameState + BotWeaponProfile + BotMovementProfile into
 * Float32Arrays normalized to [0, 1] for TensorFlow.js model input.
 *
 * Two input vectors:
 *   - Tactical (25 floats): "WHAT to do" — self state, weapons, enemy, nav
 *   - Combat (18 floats):   "HOW to fight" — enemy position, velocity, weapon
 *
 * All divisions are guarded against NaN (|| 0 fallback).
 * Array indices are FIXED — changing them requires retraining models.
 */

import type { BotGameState, VisiblePlayer } from "./BotGameState";
import { canInitiateSlide, canWallJump, PHYSICS } from "./BotMovementProfile";
import type { BotVision } from "./BotVision";
import { getWeaponProfile } from "./BotWeaponProfile";

// ── Size Constants ──────────────────────────────────────────────────
// These MUST match the model's inputShape. Changing them = model incompatible.

export const TACTICAL_INPUT_SIZE = 25;
export const COMBAT_INPUT_SIZE = 18;

// ── Helpers ─────────────────────────────────────────────────────────

function vec3Length(v: { x: number; y: number; z: number }): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function vec3Distance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Clamp value to [min, max] */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Compute relative yaw angle between bot and target, normalized to [0, 1].
 * 0.5 = target is directly ahead, 0 = hard left, 1 = hard right.
 */
function computeRelativeYaw(
  selfYaw: number,
  selfPos: { x: number; y: number; z: number },
  targetPos: { x: number; y: number; z: number },
): number {
  const dx = targetPos.x - selfPos.x;
  const dz = targetPos.z - selfPos.z;
  const angleToTarget = Math.atan2(dx, dz);
  let relAngle = angleToTarget - selfYaw;

  // Normalize to [-π, π]
  while (relAngle > Math.PI) relAngle -= 2 * Math.PI;
  while (relAngle < -Math.PI) relAngle += 2 * Math.PI;

  // Map [-π, π] → [0, 1]
  return (relAngle + Math.PI) / (2 * Math.PI);
}

/**
 * Compute pitch angle from bot to target, normalized to [0, 1].
 * 0.5 = level, 0 = looking down, 1 = looking up.
 */
function computeRelativePitch(
  selfPos: { x: number; y: number; z: number },
  targetPos: { x: number; y: number; z: number },
): number {
  const dx = targetPos.x - selfPos.x;
  const dy = targetPos.y - selfPos.y;
  const dz = targetPos.z - selfPos.z;
  const horizDist = Math.sqrt(dx * dx + dz * dz);
  const pitch = Math.atan2(dy, horizDist || 1); // Guard against zero

  // Map [-π/2, π/2] → [0, 1]
  return (pitch + Math.PI / 2) / Math.PI;
}

// ── Tactical Input Builder ──────────────────────────────────────────

/**
 * Build the TacticalBrain input vector from current game state.
 * Returns Float32Array of exactly TACTICAL_INPUT_SIZE elements, all in [0, 1].
 *
 * Index map:
 *   [0]  self health (0-200 → 0-1)
 *   [1]  self armor (0-200 → 0-1)
 *   [2]  self speed (0-1000 → 0-1)
 *   [3]  self isGrounded (0/1)
 *   [4]  self isDead (0/1)
 *   [5]  current weapon: isMelee (0/1)
 *   [6]  current weapon: isHitscan (0/1)
 *   [7]  current weapon: isProjectile (0/1)
 *   [8]  current weapon: needsADS (0/1)
 *   [9]  current weapon: DPS normalized (0-1)
 *   [10] current weapon: ammo ratio (0-1)
 *   [11] best weapon 1: DPS normalized
 *   [12] best weapon 1: ammo ratio
 *   [13] best weapon 2: DPS normalized
 *   [14] best weapon 2: ammo ratio
 *   [15] best weapon 3: DPS normalized
 *   [16] best weapon 3: ammo ratio
 *   [17] enemy distance (0-3000 → 0-1)
 *   [18] enemy relative angle (0-1, 0.5 = ahead)
 *   [19] enemy visible (0/1)
 *   [20] movement: can slide (0/1)
 *   [21] movement: can wall-jump (0/1)
 *   [22] nearest health distance (0-3000 → 0-1, 1 = none)
 *   [23] nearest armor distance (0-3000 → 0-1, 1 = none)
 *   [24] recent damage (0/1, took damage in last 30 ticks)
 */
export function buildTacticalInput(state: BotGameState, vision: BotVision | null): Float32Array {
  const input = new Float32Array(TACTICAL_INPUT_SIZE);
  const self = state.self;

  // ── Self state [0-4] ────────────────────────────────────────
  input[0] = clamp(self.health / 200, 0, 1);
  input[1] = clamp(self.armor / 200, 0, 1);
  input[2] = clamp(vec3Length(self.velocity) / PHYSICS.TOP_SPEED, 0, 1);
  input[3] = self.isGrounded ? 1 : 0;
  input[4] = self.isDead ? 1 : 0;

  // ── Current weapon profile [5-10] ───────────────────────────
  const profile = getWeaponProfile(self.currentWeapon);
  input[5] = profile.isMelee ? 1 : 0;
  input[6] = profile.isHitscan ? 1 : 0;
  input[7] = profile.isProjectile ? 1 : 0;
  input[8] = profile.needsADS ? 1 : 0;
  input[9] = clamp(profile.dps / 300, 0, 1);

  const currentAmmo = self.ammo[self.currentWeapon];
  if (currentAmmo !== undefined) {
    input[10] = clamp(currentAmmo / 100, 0, 1);
  } else {
    input[10] = 1; // Unlimited ammo (blade, etc.)
  }

  // ── Best weapons inventory [11-16] ──────────────────────────
  // Score all weapons by DPS and pick top 3
  const weaponScores: Array<{ dps: number; ammoRatio: number }> = [];
  for (const weaponId of self.weapons) {
    if (!weaponId) continue;
    const wp = getWeaponProfile(weaponId);
    const ammo = self.ammo[weaponId];
    const ammoRatio = ammo !== undefined ? clamp(ammo / 100, 0, 1) : 1;

    // Skip weapons with no ammo
    if (ammo !== undefined && ammo <= 0) continue;

    weaponScores.push({ dps: wp.dps, ammoRatio });
  }

  // Sort by DPS descending
  weaponScores.sort((a, b) => b.dps - a.dps);

  for (let i = 0; i < 3; i++) {
    const baseIdx = 11 + i * 2;
    if (i < weaponScores.length) {
      input[baseIdx] = clamp(weaponScores[i].dps / 300, 0, 1);
      input[baseIdx + 1] = weaponScores[i].ammoRatio;
    }
    // else: stays 0 (no weapon in this slot)
  }

  // ── Enemy info [17-19] ──────────────────────────────────────
  const enemy = state.getNearestEnemy();
  if (enemy) {
    const dist = vec3Distance(self.position, enemy.position);
    input[17] = clamp(dist / 3000, 0, 1);
    input[18] = computeRelativeYaw(self.yaw, self.position, enemy.position);
    input[19] = 1; // Visible
  }
  // else: stays 0 (no enemy visible)

  // ── Movement state [20-21] ──────────────────────────────────
  const currentSpeed = vec3Length(self.velocity);
  input[20] = canInitiateSlide(currentSpeed, true) ? 1 : 0; // Can slide
  input[21] = canWallJump(!self.isGrounded, PHYSICS.WALLJUMP_MIN_HEIGHT, true) ? 1 : 0;

  // ── Navigation context [22-23] ──────────────────────────────
  if (vision) {
    const healthPos = vision.findNearestItem(self.position, "health", state.pickupActiveMask);
    const armorPos = vision.findNearestItem(self.position, "armor", state.pickupActiveMask);
    input[22] = healthPos ? clamp(vec3Distance(self.position, healthPos) / 3000, 0, 1) : 1; // 1 = no health nearby
    input[23] = armorPos ? clamp(vec3Distance(self.position, armorPos) / 3000, 0, 1) : 1; // 1 = no armor nearby
  } else {
    input[22] = 1; // Unknown, assume far
    input[23] = 1;
  }

  // ── Recent damage [24] ──────────────────────────────────────
  const recentDamage = state.recentDamage.some((d) => state.tick - d.tick < 30);
  input[24] = recentDamage ? 1 : 0;

  return input;
}

// ── Combat Input Builder ────────────────────────────────────────────

/**
 * Build the CombatBrain input vector for a specific enemy.
 * Returns Float32Array of exactly COMBAT_INPUT_SIZE elements, all in [0, 1].
 *
 * Index map:
 *   [0]  enemy distance (0-3000 → 0-1)
 *   [1]  enemy relative pitch (0-1, 0.5 = level)
 *   [2]  enemy relative yaw (0-1, 0.5 = ahead)
 *   [3]  enemy velocity X (-500..500 → 0-1)
 *   [4]  enemy velocity Y (-500..500 → 0-1)
 *   [5]  enemy velocity Z (-500..500 → 0-1)
 *   [6]  self health (0-200 → 0-1)
 *   [7]  self speed (0-1000 → 0-1)
 *   [8]  self isGrounded (0/1)
 *   [9]  self is moving fast (speed > slideMinSpeed, 0/1)
 *   [10] weapon: isHitscan (0/1)
 *   [11] weapon: projectile speed normalized (0-1)
 *   [12] weapon: hasSplash (0/1)
 *   [13] weapon: needsADS (0/1)
 *   [14] weapon: fireMode auto (0/1)
 *   [15] ammo ratio (0-1)
 *   [16] time since last damage taken (0-120 ticks → 0-1)
 *   [17] recently took damage (within 30 ticks, 0/1)
 */
export function buildCombatInput(state: BotGameState, enemy: VisiblePlayer): Float32Array {
  const input = new Float32Array(COMBAT_INPUT_SIZE);
  const self = state.self;

  // ── Enemy relative position [0-2] ───────────────────────────
  const dist = vec3Distance(self.position, enemy.position);
  input[0] = clamp(dist / 3000, 0, 1);
  input[1] = computeRelativePitch(self.position, enemy.position);
  input[2] = computeRelativeYaw(self.yaw, self.position, enemy.position);

  // ── Enemy velocity [3-5] ────────────────────────────────────
  // Map [-500, 500] → [0, 1] (0.5 = stationary)
  input[3] = clamp(enemy.velocity.x / 500, -1, 1) * 0.5 + 0.5;
  input[4] = clamp(enemy.velocity.y / 500, -1, 1) * 0.5 + 0.5;
  input[5] = clamp(enemy.velocity.z / 500, -1, 1) * 0.5 + 0.5;

  // ── Self state [6-9] ────────────────────────────────────────
  input[6] = clamp(self.health / 200, 0, 1);
  input[7] = clamp(vec3Length(self.velocity) / PHYSICS.TOP_SPEED, 0, 1);
  input[8] = self.isGrounded ? 1 : 0;
  input[9] = vec3Length(self.velocity) >= PHYSICS.SLIDE_MIN_SPEED ? 1 : 0;

  // ── Current weapon profile [10-14] ──────────────────────────
  const profile = getWeaponProfile(self.currentWeapon);
  input[10] = profile.isHitscan ? 1 : 0;
  input[11] = clamp((profile.projectileSpeed || 0) / 3000, 0, 1);
  input[12] = profile.hasSplash ? 1 : 0;
  input[13] = profile.needsADS ? 1 : 0;
  input[14] = profile.fireMode === "auto" ? 1 : 0;

  // ── Combat context [15-17] ──────────────────────────────────
  const currentAmmo = self.ammo[self.currentWeapon];
  input[15] = currentAmmo !== undefined ? clamp(currentAmmo / 100, 0, 1) : 1;

  // Time since last damage taken
  const lastDamageTick = state.recentDamage.length > 0 ? state.recentDamage[state.recentDamage.length - 1].tick : 0;
  const ticksSinceDamage = lastDamageTick > 0 ? state.tick - lastDamageTick : 120;
  input[16] = clamp(ticksSinceDamage / 120, 0, 1);
  input[17] = ticksSinceDamage < 30 ? 1 : 0;

  return input;
}
