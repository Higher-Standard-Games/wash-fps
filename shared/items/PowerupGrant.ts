import type { PowerupComponent } from "../../../../shared/server/simulation/components/PowerupComponent";
import { grantedExpiryTick, type PowerupKind } from "./Powerups";

/**
 * Grant `kind` at `tick`, extending it if already held.
 * Returns the new expiry tick.
 */
export function grantPowerup(p: PowerupComponent, kind: PowerupKind, tick: number, tickRate: number): number {
  const until = grantedExpiryTick(p.expiry, kind, tick, tickRate);
  p.expiry[kind] = until;
  return until;
}
