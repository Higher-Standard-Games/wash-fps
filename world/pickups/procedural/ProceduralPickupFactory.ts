/**
 * Procedural pickup factory (docs/research/PROCEDURAL_ITEMS.md §"Runtime
 * construction sequence"). Bridges the engine-generic `PickupVisualFactory` seam
 * to the FPS health/armor recipe family.
 *
 * `EntityManager` injects one of these into `PickupOptions.visualFactory` when a
 * health/armor pickup is spawned (and procedural mode is enabled). `Pickup` then
 * calls it after ground placement to build the sculpture. Returns `null` for any
 * id without a recipe, so the pickup transparently falls back to its MD3 model.
 */

import type { PickupVisual, PickupVisualFactory } from "../../../../../engine/world/PickupVisual";
import { getProceduralPickupRecipe } from "./ProceduralPickupRecipes";
import { ProceduralPickupVisual } from "./ProceduralPickupVisual";

/**
 * Build a factory bound to a registry id (`health_medium`, `armor_ya`, …).
 * Returns `null` up front if the id has no procedural recipe, so the caller can
 * decide to fall back to the model path before even setting `visualFactory`.
 */
export function createProceduralPickupFactory(registryId: string): PickupVisualFactory | null {
  const recipe = getProceduralPickupRecipe(registryId);
  if (!recipe) return null;
  return (ctx): PickupVisual | null => {
    // Server-managed pickups start hidden until their first authoritative
    // active-mask arrives (fail-closed). Dev-spawned previews build visible.
    const startHidden = ctx.options.serverManagedRespawn === true;
    const seed = ctx.options.pickupId ?? 0;
    return new ProceduralPickupVisual(ctx.scene, recipe, ctx.position, startHidden, seed);
  };
}
