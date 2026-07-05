/**
 * CombatSystem — knockback/damage decoupling (F4).
 *
 * Knockback force was `finalDamage * kbScale`, so a 0-damage hit produced 0
 * knockback — which broke instagib "insta-jump" (self-damage 0 → no launch).
 * DamageEvent.knockbackDamage now supplies the push magnitude independently of
 * the dealt damage, falling back to the applied damage for normal hits.
 */

import { describe, expect, it } from "vitest";
import { CombatSystem, DamageType, HitLocation } from "../CombatSystem";

function setup() {
  const combat = new CombatSystem();
  const impulses: { force: number; dirY: number; entityId: number }[] = [];
  combat.setMovementSubsystem({
    queueImpulse: (i: { force: number; dirY: number; entityId: number }) => impulses.push(i),
  } as never);
  const victim = {
    id: 1,
    health: { health: 100, armor: 0, dead: false, maxHealth: 100, maxArmor: 100 },
    transform: { position: { x: 0, y: 0, z: 0 } },
  };
  const state = { getEntityMut: () => victim, getEntity: () => victim };
  return { combat, impulses, victim, state };
}

describe("CombatSystem — knockback decoupling", () => {
  it("applies knockback at 0 damage via knockbackDamage (insta-jump)", () => {
    const { combat, impulses, victim, state } = setup();

    combat.queueDamage({
      victimId: 1 as never,
      attackerId: 1 as never, // self
      damage: 0, // instagib self-damage gated to 0
      knockbackDamage: 50, // but still launch
      armorPiercing: 0,
      damageType: DamageType.Explosion,
      hitLocation: HitLocation.Body,
      knockbackDir: { x: 0, y: 1, z: 0 },
      knockbackScale: 10,
    });
    combat.update(state as never, 0.008, 1 as never);

    expect(victim.health.health).toBe(100); // no health lost
    expect(impulses).toHaveLength(1);
    // self → SELF_KB_MULTIPLIER 0.5; force = 50 * 10 * 0.5 = 250
    expect(impulses[0].force).toBe(250);
    expect(impulses[0].dirY).toBeGreaterThan(0);
  });

  it("falls back to dealt damage when knockbackDamage is absent (unchanged behavior)", () => {
    const { combat, impulses, victim, state } = setup();

    combat.queueDamage({
      victimId: 1 as never,
      attackerId: 2 as never, // enemy
      damage: 30,
      armorPiercing: 0,
      damageType: DamageType.Bullet,
      hitLocation: HitLocation.Body,
      knockbackDir: { x: 1, y: 0, z: 0 },
      knockbackScale: 10,
    });
    combat.update(state as never, 0.008, 1 as never);

    expect(victim.health.health).toBe(70);
    // enemy → selfMult 1; force = finalDamage(30) * 10 = 300
    expect(impulses[0].force).toBe(300);
  });
});
