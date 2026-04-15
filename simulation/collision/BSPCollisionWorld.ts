/**
 * BSPCollisionWorld - Client-side factory for SharedCollisionWorld
 *
 * Extracts the Q3 SweepCollisionBackend from the CollisionManager singleton
 * and wraps it in SharedCollisionWorld for physics parity with the server.
 */

import type { CollisionWorld } from "../../../../engine/network/systems/collision/CollisionWorld";
import { getCollisionManager } from "../../../../engine/physics/CollisionManager";
import { SharedCollisionWorld } from "../../../../shared/collision/SharedCollisionWorld";

/**
 * Create a client-side CollisionWorld from the CollisionManager singleton.
 *
 * Returns SharedCollisionWorld (same code as server) wrapping the Q3 backend,
 * or null if CollisionManager isn't initialized yet.
 */
export function createBSPCollisionWorld(): CollisionWorld | null {
  const cm = getCollisionManager();

  if (!cm.isInitialized()) {
    console.warn("[BSPCollisionWorld] CollisionManager not initialized");
    return null;
  }

  // Extract the Q3 sweep collision backend
  const backend = (cm as any).backends?.get("q3");
  if (!backend || typeof backend.stepSlideMove !== "function") {
    console.warn("[BSPCollisionWorld] Q3 backend not available");
    return null;
  }

  console.log("[BSPCollisionWorld] Created SharedCollisionWorld with Q3 backend");
  return new SharedCollisionWorld(backend);
}

// Re-export SharedCollisionWorld as BSPCollisionWorld for backward compat
export { SharedCollisionWorld as BSPCollisionWorld } from "../../../../shared/collision/SharedCollisionWorld";
