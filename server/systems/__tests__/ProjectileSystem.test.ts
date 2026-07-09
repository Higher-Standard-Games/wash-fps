/**
 * ProjectileSystem — F6 projectile gravity regression.
 *
 * Previously every non-grenade projectile got a blanket `velocity.y -= 50 * dt`,
 * so rockets/plasma/blasts sagged below the crosshair over distance. Gravity is
 * now per-weapon (`WeaponDef.projectileGravity` → meta.gravity): 0 = fly straight,
 * >0 = arc (grenades). This asserts a gravity-0 projectile keeps a constant
 * vertical velocity while a gravity>0 one drops.
 */

import { describe, expect, it } from "vitest";
import { EntityType } from "@engine/server/ecs/types";
import { GRENADE } from "../../../../../shared/entities/definitions/projectiles/grenade";
import { WEAPONS } from "../../weapons/WeaponDef";
import { DamageType } from "../CombatSystem";
import { ProjectileSystem } from "../ProjectileSystem";

function makeProjectile(id: number, vy: number) {
  return {
    id,
    ownerId: 99,
    transform: { position: { x: 0, y: 1000, z: 0 } },
    physics: { velocity: { x: 0, y: vy, z: 1000 } },
  };
}

function makeState(projectiles: unknown[]) {
  return {
    entitiesByType: (t: EntityType) => (t === EntityType.Projectile ? projectiles : []),
    getEntityMut: (id: number) => projectiles.find((p) => (p as { id: number }).id === id),
    getEntityByOwner: () => undefined,
    removeEntity: () => {},
  };
}

describe("ProjectileSystem — F6 per-weapon gravity", () => {
  it("gravity-0 projectile flies straight (vertical velocity unchanged)", () => {
    const sys = new ProjectileSystem();
    const proj = makeProjectile(1, 0);
    sys.registerProjectileType(1 as never, "rlauncher", { gravity: 0, lifetime: 10 });

    for (let tick = 1; tick <= 10; tick++) {
      sys.update(makeState([proj]) as never, 1 / 125, tick as never);
    }

    expect(proj.physics.velocity.y).toBe(0); // no hidden sag
  });

  it("gravity>0 projectile arcs downward", () => {
    const sys = new ProjectileSystem();
    const proj = makeProjectile(2, 0);
    sys.registerProjectileType(2 as never, "glauncher", { gravity: GRENADE.gravity, lifetime: 10 });

    for (let tick = 1; tick <= 10; tick++) {
      sys.update(makeState([proj]) as never, 1 / 125, tick as never);
    }

    const grenadeGravity = GRENADE.gravity ?? 0;
    const expectedDrop = 800 * grenadeGravity * (10 / 125);
    expect(proj.physics.velocity.y).toBeCloseTo(-expectedDrop, 3);
  });

  it("grenade defaults travel in the Warsow-like 45-degree range before timeout", () => {
    const sys = new ProjectileSystem({ trace: () => ({ fraction: 1 }) } as never);
    const grenadeGravity = GRENADE.gravity ?? 0;
    const component = GRENADE.speed / Math.SQRT2;
    const proj = {
      id: 3,
      ownerId: 99,
      transform: { position: { x: 0, y: 0, z: 0 } },
      physics: { velocity: { x: 0, y: component, z: component } },
    };

    sys.registerProjectileType(3 as never, GRENADE.id, {
      bounces: GRENADE.bounces,
      lifetime: GRENADE.lifetime,
      gravity: grenadeGravity,
      bounceFactor: GRENADE.bounceFactor,
    });

    const state = makeState([proj]);
    const ticksBeforeTimeout = Math.floor((GRENADE.lifetime - 1 / 125) * 125);
    for (let tick = 1; tick <= ticksBeforeTimeout; tick++) {
      sys.update(state as never, 1 / 125, tick as never);
    }

    const horizontalDistance = Math.hypot(proj.transform.position.x, proj.transform.position.z);
    expect(horizontalDistance).toBeGreaterThanOrEqual(940);
    expect(horizontalDistance).toBeLessThanOrEqual(1100);
  });
});

describe("ProjectileSystem — F8 projectile identity", () => {
  it("projectile-id aliases resolve to their owning weapon's stats", () => {
    expect(WEAPONS.rocket).toBe(WEAPONS.rlauncher);
    expect(WEAPONS.grenade).toBe(WEAPONS.glauncher);
    expect(WEAPONS.plasma_bolt).toBe(WEAPONS.plasmagun);
    expect(WEAPONS.gunblade_blast).toBe(WEAPONS.gunblade);
  });

  it("a projectile registered by projectileId deals its weapon's damage on direct hit", () => {
    const sys = new ProjectileSystem();
    const proj = {
      id: 1,
      ownerId: 99,
      transform: { position: { x: 0, y: 1000, z: 0 } },
      physics: { velocity: { x: 0, y: 0, z: 1000 } },
    };
    const player = {
      id: 2,
      ownerId: 1,
      transform: { position: { x: 0, y: 1000, z: 6 } }, // ~8u ahead after one tick → direct hit
      health: { dead: false, health: 100, armor: 0, maxHealth: 100, maxArmor: 100 },
    };
    const state = {
      entitiesByType: (t: EntityType) =>
        t === EntityType.Projectile ? [proj] : t === EntityType.Player ? [player] : [],
      getEntityMut: (id: number) => (id === 1 ? proj : undefined),
      getEntityByOwner: () => undefined,
      removeEntity: () => {},
    };

    sys.registerProjectileType(1 as never, "rocket", { gravity: 0, lifetime: 10 });
    sys.update(state as never, 1 / 125, 1 as never);

    const direct = sys.getPendingDamage().find((d) => (d.victimId as unknown as number) === 2);
    expect(direct).toBeDefined();
    expect(direct!.damage).toBe(WEAPONS.rlauncher.damage); // resolved via the "rocket" alias, not the 80 fallback
    expect(direct!.damageType).toBe(DamageType.Explosion);
  });
});
