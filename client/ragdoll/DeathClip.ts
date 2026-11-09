import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { DeathEvent } from "../../../../engine/network/core/SnapshotEvent";

/** The one-shot a body plays while it is thrown, before the ragdoll takes over. */
export type DeathClip = "death_flying_back" | "death_from_back" | "death_headshot";

/** A push within 60 degrees of the victim's facing came from behind. */
const BEHIND_COS = Math.cos(Math.PI / 3);
/** Below this horizontal share the push is straight up (a blast at the feet) and has no side. */
const MIN_HORIZONTAL = 0.1;

/** What a death event says about the killing blow. */
export type DeathFacts = Pick<DeathEvent, "damageType" | "killWeapon" | "hitLocation" | "kbDirX" | "kbDirZ">;

/**
 * The clip a ragdoll death plays, or null for a plain ragdoll. Gib deaths never
 * get here. A kill from behind plays `death_from_back` whatever dealt it; from
 * the front or side a headshot plays `death_headshot`, and a riotgun blast or
 * an explosion plays `death_flying_back`.
 */
export function chooseDeathClip(event: DeathFacts, victimYaw: number): DeathClip | null {
  const kbX = event.kbDirX || 0;
  const kbZ = event.kbDirZ || 0;
  const horizontal = Math.hypot(kbX, kbZ);
  if (horizontal < MIN_HORIZONTAL) return null;
  // The push runs along the victim's facing when the shot came from behind
  const along = (Math.sin(victimYaw) * kbX + Math.cos(victimYaw) * kbZ) / horizontal;
  if (along >= BEHIND_COS) return "death_from_back";
  if (event.hitLocation === "head") return "death_headshot";
  if (event.killWeapon === "riotgun" || event.damageType === "explosion") return "death_flying_back";
  return null;
}

/**
 * The yaw a body playing `clip` turns to: facing the shot for a blow from the
 * front, so the push throws it straight back, and facing away from it for one
 * from behind.
 */
export function deathClipYaw(clip: DeathClip, kbDirX: number, kbDirZ: number): number {
  return clip === "death_from_back" ? Math.atan2(kbDirX, kbDirZ) : Math.atan2(-kbDirX, -kbDirZ);
}

/** The yaw a body's anchor carries, from either rotation form. */
export function anchorYaw(anchor: TransformNode): number {
  return anchor.rotationQuaternion ? anchor.rotationQuaternion.toEulerAngles().y : anchor.rotation.y;
}
