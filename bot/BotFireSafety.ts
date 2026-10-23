import type { BotInput } from "./BotBrain";
import { InputButtons } from "./BotConfig";
import type { BotGameState, VisiblePlayer } from "./BotGameState";

export interface FireSafetyResult {
  input: BotInput;
  suppressed: boolean;
  blockingAlly: VisiblePlayer | null;
}

export interface FireSafetyOptions {
  eyeHeight?: number;
  allyRadius?: number;
  maxDistance?: number;
}

/**
 * Final friendly-fire gate shared by rule-based and neural brains.
 * It suppresses attacks when a living ally intersects the current aim ray.
 */
export function applyFriendlyFireSafety(
  input: BotInput,
  state: BotGameState,
  options: FireSafetyOptions = {},
): FireSafetyResult {
  const attackMask = InputButtons.FIRE | InputButtons.ALT_FIRE;
  if ((input.buttons & attackMask) === 0) {
    return { input, suppressed: false, blockingAlly: null };
  }

  const allies = state.getAllies();
  if (allies.length === 0) {
    return { input, suppressed: false, blockingAlly: null };
  }

  const eyeHeight = options.eyeHeight ?? 32;
  const allyRadius = options.allyRadius ?? 36;
  const maxDistance = options.maxDistance ?? 4000;
  const origin = {
    x: state.self.position.x,
    y: state.self.position.y + eyeHeight,
    z: state.self.position.z,
  };
  const cosPitch = Math.cos(input.pitch);
  const forward = {
    x: Math.sin(input.yaw) * cosPitch,
    y: -Math.sin(input.pitch),
    z: Math.cos(input.yaw) * cosPitch,
  };

  for (const ally of allies) {
    const toAlly = {
      x: ally.position.x - origin.x,
      y: ally.position.y + eyeHeight * 0.75 - origin.y,
      z: ally.position.z - origin.z,
    };
    const alongRay = toAlly.x * forward.x + toAlly.y * forward.y + toAlly.z * forward.z;
    if (alongRay <= 0 || alongRay > maxDistance) continue;

    const distanceSquared = toAlly.x * toAlly.x + toAlly.y * toAlly.y + toAlly.z * toAlly.z - alongRay * alongRay;
    if (distanceSquared <= allyRadius * allyRadius) {
      return {
        input: { ...input, buttons: input.buttons & ~attackMask },
        suppressed: true,
        blockingAlly: ally,
      };
    }
  }

  return { input, suppressed: false, blockingAlly: null };
}
