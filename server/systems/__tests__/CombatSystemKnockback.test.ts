/**
 * CombatSystem — knockback force is the applied damage × the weapon's scale.
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

describe("CombatSystem — knockback force", () => {
  it("scales the dealt damage by the weapon's knockback scale", () => {
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

/**
 * The kill event's kbDir drives the client ragdoll launch. It used to forward
 * the RAW authored direction while the gameplay impulse used a normalized,
 * upward-biased vector — so the corpse flew along a different vector than the
 * push that killed the player. Worse, an unnormalized or near-vertical raw
 * direction left the client with no usable horizontal component, and it fell
 * back to a random compass heading at full launch speed.
 */
describe("CombatSystem — kill event knockback direction", () => {
  function kill(knockbackDir: { x: number; y: number; z: number }) {
    const combat = new CombatSystem();
    const impulses: { dirX: number; dirY: number; dirZ: number }[] = [];
    combat.setMovementSubsystem({
      queueImpulse: (i: { dirX: number; dirY: number; dirZ: number }) => impulses.push(i),
    } as never);
    const victim = {
      id: 1,
      health: { health: 10, armor: 0, dead: false, maxHealth: 100, maxArmor: 100 },
      transform: { position: { x: 0, y: 0, z: 0 } },
      physics: { velocity: { x: 0, y: 0, z: 0 } },
    };
    const state = { getEntityMut: () => victim, getEntity: () => victim };

    combat.queueDamage({
      victimId: 1 as never,
      attackerId: 2 as never,
      damage: 999,
      armorPiercing: 0,
      damageType: DamageType.Explosion,
      hitLocation: HitLocation.Body,
      knockbackDir,
      knockbackScale: 10,
    });
    combat.update(state as never, 0.008, 1 as never);
    return { kills: combat.getRecentKills(), impulses };
  }

  it("sends a unit-length direction even when the authored vector is not normalized", () => {
    // A rocket's knockbackDir is its raw velocity — magnitude in the hundreds.
    const { kills } = kill({ x: 900, y: 0, z: 0 });
    expect(kills).toHaveLength(1);
    const k = kills[0];
    const len = Math.sqrt(k.kbDirX * k.kbDirX + k.kbDirY * k.kbDirY + k.kbDirZ * k.kbDirZ);
    expect(len).toBeCloseTo(1, 5);
  });

  it("matches the direction actually applied as the gameplay impulse", () => {
    const { kills, impulses } = kill({ x: 3, y: 0, z: -4 });
    expect(impulses).toHaveLength(1);
    expect(kills[0].kbDirX).toBeCloseTo(impulses[0].dirX, 6);
    expect(kills[0].kbDirY).toBeCloseTo(impulses[0].dirY, 6);
    expect(kills[0].kbDirZ).toBeCloseTo(impulses[0].dirZ, 6);
  });

  it("keeps a strong upward component so the ragdoll pops rather than skates", () => {
    // Purely horizontal push still gets KB_UPWARD_BIAS folded in.
    const { kills } = kill({ x: 1, y: 0, z: 0 });
    expect(kills[0].kbDirY).toBeGreaterThan(0.5);
  });

  it("gives a splash kill at the victim's feet a usable vertical direction", () => {
    // Explosion directly below: no horizontal component at all. This is the case
    // that used to make the client invent a random heading.
    const { kills } = kill({ x: 0, y: 1, z: 0 });
    const k = kills[0];
    expect(k.kbDirY).toBeCloseTo(1, 5);
    expect(Math.hypot(k.kbDirX, k.kbDirZ)).toBeLessThan(0.001);
  });
});
