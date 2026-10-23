import { describe, expect, it } from "vitest";
import {
  clearPowerups,
  clonePowerups,
  createPowerups,
} from "../../../../../shared/server/simulation/components/PowerupComponent";
import { grantPowerup } from "../PowerupGrant";
import { packPowerupMask, powerupDamageMultiplier } from "../Powerups";

describe("game powerup grants through shared ECS storage", () => {
  it("extends quad without changing a COW clone and clears held effects on death", () => {
    const held = createPowerups();
    expect(grantPowerup(held, "quad", 1000, 125)).toBe(4750);
    const prior = clonePowerups(held);
    expect(grantPowerup(held, "quad", 2250, 125)).toBe(8500);
    expect(prior.expiry).toEqual({ quad: 4750 });
    expect(packPowerupMask(held.expiry, 4750)).toBe(1);
    expect(packPowerupMask(prior.expiry, 4750)).toBe(0);
    expect(powerupDamageMultiplier(held.expiry, 4750)).toBe(4);
    clearPowerups(held);
    expect(packPowerupMask(held.expiry, 4750)).toBe(0);
    expect(powerupDamageMultiplier(held.expiry, 4750)).toBe(1);
    expect(prior.expiry).toEqual({ quad: 4750 });
  });
});
