/**
 * Where a hit landed, as the server names it in a damage event.
 *
 * An event without one (an older server, or a demo recorded before the engine carried it)
 * is treated as a body hit.
 */
export type HitLocationName = "body" | "head" | "legs";

export function isHeadHit(location: HitLocationName | undefined): boolean {
  return location === "head";
}
