import { TAUNT_ANIMS } from "../../../engine/animation/PlayerModelManager";
import type { DeathEvent } from "../../../engine/network/core/SnapshotEvent";

/** Share of kills after which the killer taunts. */
export const KILL_TAUNT_CHANCE = 0.3;

/** What a death event says about who died where, by whom. */
export type KillFacts = Pick<DeathEvent, "entityId" | "killerId" | "x" | "y" | "z">;

/**
 * The taunt a killer plays over their upper body after `event`, or null for
 * none (seven kills in ten, and every suicide or world death). The roll is a
 * hash of the event, so every viewer and every replay of a demo sees the same
 * taunt.
 */
export function chooseKillTaunt(event: KillFacts, taunts: readonly string[] = TAUNT_ANIMS): string | null {
  if (!event.killerId || event.killerId === event.entityId || !taunts.length) return null;
  const hash = fnv1a(
    `${event.entityId}|${event.killerId}|${Math.round(event.x || 0)}|${Math.round(event.y || 0)}|${Math.round(event.z || 0)}`,
  );
  if ((hash % 1000) / 1000 >= KILL_TAUNT_CHANCE) return null;
  return taunts[Math.floor(hash / 1000) % taunts.length];
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
