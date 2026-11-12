import type { TriggerVolume } from "../../../shared/bsp/TriggerTable";
import type { Vec3 } from "./BotGameState";

/** One snapshot of movement never covers this much; a teleport does. */
const TELEPORT_STEP = 150;
/** A teleporter's exit origin sits this far above its destination. */
const TELEPORT_EXIT_LIFT = 25;
/** How far the bot may have moved on from the exit by the time the snapshot shows it. */
const EXIT_TOLERANCE = 96;

/**
 * The view yaw a teleporter set, when the bot's own position jumped from
 * `before` to `after` by going through one; null otherwise. A human client
 * learns this from its own prediction; a bot only sees it in the snapshot.
 */
export function teleportExitYaw(before: Vec3, after: Vec3, triggers: readonly TriggerVolume[]): number | null {
  if (Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z) < TELEPORT_STEP) return null;
  let best: TriggerVolume | null = null;
  let bestDistance = EXIT_TOLERANCE;
  for (const trigger of triggers) {
    if (trigger.type !== "teleport") continue;
    const distance = Math.hypot(
      after.x - trigger.dest.x,
      after.y - (trigger.dest.y + TELEPORT_EXIT_LIFT),
      after.z - trigger.dest.z,
    );
    if (distance <= bestDistance) {
      best = trigger;
      bestDistance = distance;
    }
  }
  return best ? (best.destYaw ?? 0) : null;
}
