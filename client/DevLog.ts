import { Cvar } from "../../../engine/core/Cvar";

/**
 * A console line for lines that repeat in play: every death, ragdoll, weapon
 * change, spectate switch or respawn. Printed only with `developer 1`, so a
 * normal session's console shows what happened once (connecting, the map, the
 * match phase) and warnings, not a line per frag.
 *
 * Production builds strip console.log either way; this is for development.
 */
export function devLog(...args: unknown[]): void {
  if (Cvar.getBool("developer")) console.log(...args);
}
