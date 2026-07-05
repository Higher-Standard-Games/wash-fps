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
    sys.registerProjectileType(2 as never, "glauncher", { gravity: 3, lifetime: 10 });

    for (let tick = 1; tick <= 10; tick++) {
      sys.update(makeState([proj]) as never, 1 / 125, tick as never);
    }

    // 800 * 3 * (10/125) = 192 u/s downward
    expect(proj.physics.velocity.y).toBeCloseTo(-192, 3);
  });
});
