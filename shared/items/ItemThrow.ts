/**
 * ItemThrow — the throw every loose item uses.
 *
 * A dropped weapon and a map-spawned weapon are both a small box given a
 * velocity and stepped through the shared collision world until it comes to
 * rest. The server steps drops live. Map items come to rest when a map loads —
 * weapons thrown, everything else dropped straight down — identically on the
 * server, the client and in bot map knowledge: all of them run this code
 * against the same SharedCollisionWorld over the same BSP, so an item's resting
 * spot — and with it the pickup trigger and bot item goals — agrees everywhere
 * without being replicated.
 */

import type { AABB, CollisionWorld } from "../../../../shared/collision/CollisionWorld";
import type { Vec3 } from "../../../../shared/server/simulation/types";
import type { PickupEntry } from "../bsp/PickupTable";

/** Gravity on a thrown item (units/s²). */
export const ITEM_GRAVITY = 800;

/** Collision box of a thrown item. */
export const ITEM_BOUNDS: AABB = { min: { x: -4, y: -4, z: -4 }, max: { x: 4, y: 4, z: 4 } };

/** Simulation step items are thrown at: the server's base tick. */
export const ITEM_STEP_SECONDS = 1 / 125;

/** Horizontal velocity kept per grounded step. */
const GROUND_FRICTION = 0.82;

/** Speed below which a grounded item has come to rest (units/s). */
const SETTLE_SPEED = 5;

/** How long a map weapon's throw is followed before it is treated as never landing. */
const MAX_LANDING_STEPS = 5 * 125;

/** Upward pop given to a map-spawned weapon. */
const MAP_TOSS_UP = 95;

/** Horizontal scatter of that pop, kept small so a weapon lands beside its authored spot. */
const MAP_TOSS_SPREAD = 22;

export interface ThrownItem {
  position: Vec3;
  velocity: Vec3;
  settled: boolean;
}

/** Advance a thrown item one step: gravity, collision, then ground friction and settling. */
export function stepThrownItem(item: ThrownItem, collision: CollisionWorld, dt: number = ITEM_STEP_SECONDS): void {
  if (item.settled) return;
  const { position, velocity } = item;
  velocity.y -= ITEM_GRAVITY * dt;

  const result = collision.stepSlideMove(
    { x: position.x, y: position.y, z: position.z },
    { x: velocity.x, y: velocity.y, z: velocity.z },
    dt,
    ITEM_BOUNDS,
  );
  position.x = result.endPos.x;
  position.y = result.endPos.y;
  position.z = result.endPos.z;
  velocity.x = result.velocity.x;
  velocity.y = result.velocity.y;
  velocity.z = result.velocity.z;

  if (!result.grounded) return;
  velocity.x *= GROUND_FRICTION;
  velocity.z *= GROUND_FRICTION;
  const horizontalSpeed = Math.sqrt(velocity.x * velocity.x + velocity.z * velocity.z);
  if (horizontalSpeed < SETTLE_SPEED && Math.abs(velocity.y) < SETTLE_SPEED) {
    velocity.x = 0;
    velocity.y = 0;
    velocity.z = 0;
    item.settled = true;
  }
}

/**
 * Throw an item until it comes to rest. Returns where it settled, or null when
 * it never does within the step budget — falling into a void, or wedged.
 */
export function landThrownItem(
  start: Vec3,
  velocity: Vec3,
  collision: CollisionWorld,
  maxSteps: number = MAX_LANDING_STEPS,
): Vec3 | null {
  const item: ThrownItem = { position: { ...start }, velocity: { ...velocity }, settled: false };
  for (let step = 0; step < maxSteps && !item.settled; step++) {
    stepThrownItem(item, collision);
  }
  return item.settled ? item.position : null;
}

/** A map weapon's spawn toss, derived from its pickup id so every side throws it the same way. */
export function mapWeaponTossVelocity(pickupId: number): Vec3 {
  const angle = ((pickupId * 2.399963) % (Math.PI * 2)) + 0.5;
  const spread = MAP_TOSS_SPREAD * (0.35 + ((pickupId * 0.618) % 1) * 0.65);
  return { x: Math.cos(angle) * spread, y: MAP_TOSS_UP, z: Math.sin(angle) * spread };
}

/**
 * The pickup table with every map item where it comes to rest: a weapon where
 * its spawn toss lands, anything else dropped straight onto the floor beneath
 * it. Maps often put armor or health some way above the floor for the game to
 * drop, and a trigger left up there cannot be reached from where the item is
 * drawn. An item the map marks suspended keeps its spot, as does one that never
 * settles. Without a collision world the table is returned unchanged.
 */
export function landMapPickups(entries: readonly PickupEntry[], collision: CollisionWorld | null): PickupEntry[] {
  return entries.map((entry) => {
    if (!collision) return entry;
    if (entry.type !== "weapon" && entry.suspended) return entry;
    const velocity = entry.type === "weapon" ? mapWeaponTossVelocity(entry.id) : { x: 0, y: 0, z: 0 };
    const rest = landThrownItem(entry.position, velocity, collision);
    return rest ? { ...entry, position: rest } : entry;
  });
}
