/**
 * The local player's air, mirrored client-side for presentation.
 *
 * Deliberately a mirror rather than replicated state. Air is worth showing and
 * worth hearing, and neither needs to be authoritative: the server already
 * owns the damage, and a HUD meter that disagrees by a tenth of a second has
 * cost nothing. Adding a wire field would be paying protocol for a number the
 * client can derive.
 *
 * It runs the SAME pure rules the server does, so the two cannot drift in
 * their model — only in their timing.
 */

import {
  airFraction,
  createLiquidEffectState,
  type LiquidEffectState,
  tickLiquidEffects,
} from "../../server/systems/LiquidWorldEffects";
import type { WaterLevel } from "../LiquidTypes";

export class LocalAirTracker {
  private state: LiquidEffectState = createLiquidEffectState();

  /** Fires the moment air runs out, for the gasp. */
  public onStartedDrowning: (() => void) | null = null;

  /** Fires on each drowning tick after that, for the gurgle. */
  public onDrownTick: (() => void) | null = null;

  update(level: WaterLevel, deltaTime: number): void {
    // Lava and slime are passed as false: this mirror exists for air, and the
    // burn is the server's business. Duplicating damage-relevant rules on the
    // client would invite exactly the divergence the mirror is cheap because
    // it avoids.
    const result = tickLiquidEffects(this.state, level, false, false, deltaTime);

    if (result.startedDrowning) this.onStartedDrowning?.();
    else if (result.drownDamage > 0) this.onDrownTick?.();
  }

  /** 1 full, 0 empty. Only meaningful while submerged. */
  get air(): number {
    return airFraction(this.state);
  }

  /** True once the lungs are empty and the damage has begun. */
  get drowning(): boolean {
    return this.state.air <= 0;
  }

  /**
   * Refill on respawn.
   *
   * Without this a player who drowned comes back with the empty lungs they
   * died with, and the HUD tells them so a fraction of a second before the
   * server disagrees.
   */
  reset(): void {
    this.state = createLiquidEffectState();
  }
}
