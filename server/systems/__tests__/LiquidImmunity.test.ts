/**
 * A body slime and lava do not burn (a campaign boss wading through amphi1's
 * pool): movement still tracks the liquid, but queues no burn for it.
 */
import { describe, expect, it, vi } from "vitest";
import { Contents } from "../../../../../shared/collision/CollisionWorld";
import { FPSMovementSubsystem } from "../FPSMovementSubsystem";

type Inside = {
  applyLiquidWorldEffects(entityId: number, physics: unknown, dead: boolean, dt: number): void;
};

/** A second waist-deep in slime; the burns movement queued for it. */
function wade(immune: boolean) {
  const movement = new FPSMovementSubsystem();
  const queueDamage = vi.fn();
  movement.setCombatSystem({ queueDamage } as never);
  movement.setLiquidImmune(() => immune);
  const physics = { waterLevel: 2, liquidContents: Contents.SLIME };
  for (let i = 0; i < 125; i++) (movement as unknown as Inside).applyLiquidWorldEffects(7, physics, false, 1 / 125);
  return queueDamage;
}

describe("liquid immunity", () => {
  it("burns an ordinary body in slime", () => {
    expect(wade(false)).toHaveBeenCalled();
  });

  it("does not burn a body slime cannot hurt", () => {
    expect(wade(true)).not.toHaveBeenCalled();
  });
});
