/**
 * CombatSystem armor-absorption regression.
 *
 * Guards against the bug where processDamage passed event.armorPiercing (0 =
 * normal) as applyDamage's 3rd arg — which is armorABSORPTION, not piercing —
 * so armor absorbed 0% of damage, never degraded, and gave no protection.
 */

import { describe, expect, it } from "vitest";
import { CombatSystem, DamageType, HitLocation } from "../CombatSystem";

function makeVictim() {
  return {
    id: 1,
    health: { health: 100, armor: 100, dead: false, maxHealth: 100, maxArmor: 100 },
    transform: { position: { x: 0, y: 0, z: 0 } },
  };
}

function makeState(victim: ReturnType<typeof makeVictim>) {
  return {
    getEntityMut: () => victim,
    getEntity: () => victim,
  };
}

describe("CombatSystem armor absorption", () => {
  it("degrades armor and partially shields health (armorPiercing 0 → normal absorption)", () => {
    const combat = new CombatSystem();
    const victim = makeVictim();

    combat.queueDamage({
      victimId: 1 as never,
      attackerId: 2 as never,
      damage: 30,
      armorPiercing: 0, // normal — armor should soak ~2/3
      damageType: DamageType.Bullet,
      hitLocation: HitLocation.Body, // ×1.0
    });
    combat.update(makeState(victim) as never, 0.008, 1 as never);

    // Armor must drop (the bug left it at 100), and absorb MORE than health lost.
    expect(victim.health.armor).toBeLessThan(100);
    expect(victim.health.health).toBeLessThan(100);
    const armorLost = 100 - victim.health.armor;
    const healthLost = 100 - victim.health.health;
    expect(armorLost).toBeGreaterThan(healthLost); // ~0.66 vs ~0.34 of 30
    // Total damage conserved (armor + health absorbed the full 30).
    expect(armorLost + healthLost).toBeCloseTo(30, 1);
  });

  it("full armor-piercing (1) bypasses armor entirely", () => {
    const combat = new CombatSystem();
    const victim = makeVictim();

    combat.queueDamage({
      victimId: 1 as never,
      damage: 30,
      armorPiercing: 1, // full bypass → armor untouched, all to health
      damageType: DamageType.Rail,
      hitLocation: HitLocation.Body,
    });
    combat.update(makeState(victim) as never, 0.008, 1 as never);

    expect(victim.health.armor).toBe(100); // untouched
    expect(victim.health.health).toBe(70); // full 30 to health
  });
});
