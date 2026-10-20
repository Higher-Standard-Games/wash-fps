/**
 * BSPCollisionWorld - Client-side factory for SharedCollisionWorld
 *
 * Extracts the Q3 SweepCollisionBackend from the CollisionManager singleton
 * and wraps it in SharedCollisionWorld for physics parity with the server.
 */

import { devLog } from "../../../../engine/core/DevLog";
import { getCollisionManager } from "../../../../engine/physics/CollisionManager";
import { SweepBackendAdapter } from "../../../../engine/physics/SweepBackendAdapter";
import type { CollisionWorld } from "../../../../shared/collision/CollisionWorld";
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

  devLog("[BSPCollisionWorld] Created SharedCollisionWorld with Q3 backend");
  // Adapter converts structural Vec3 <-> Babylon at the engine boundary (QA-WO8)
  return new SharedCollisionWorld(new SweepBackendAdapter(backend));
}

// Re-export SharedCollisionWorld as BSPCollisionWorld for backward compat
export { SharedCollisionWorld as BSPCollisionWorld } from "../../../../shared/collision/SharedCollisionWorld";
