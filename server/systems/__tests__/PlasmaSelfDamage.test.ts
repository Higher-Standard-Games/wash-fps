import { WorldState } from "@engine/server/core/WorldState";
import { createPlayerEntity } from "@engine/server/ecs/Entity";
import { EntityType, entityId, playerId, tickNumber } from "@engine/server/ecs/types";
import { describe, expect, it } from "vitest";
import { InputButtons } from "../../../../../engine/network/components/InputComponent";
import type { CollisionWorld } from "../../../../../engine/network/systems/collision/CollisionWorld";
import { WEAPONS } from "../../../shared/entities/definitions/weapons/WeaponsTable";
import { CombatSystem, DamageType } from "../CombatSystem";
import { ProjectileSystem } from "../ProjectileSystem";
import { WeaponSystem } from "../WeaponSystem";

function fireAtWall(wallZ: number, multiplier = 1) {
  const collision = {
    trace: (start: { x: number; y: number; z: number }, end: { x: number; y: number; z: number }) => {
      const plane = wallZ - 2;
      if (end.z < plane) return { fraction: 1 };
      const fraction = start.z >= plane ? 0 : (plane - start.z) / (end.z - start.z);
      return {
        fraction,
        hitPoint: {
          x: start.x + (end.x - start.x) * fraction,
          y: start.y + (end.y - start.y) * fraction,
          z: start.z + (end.z - start.z) * fraction,
        },
        normal: { x: 0, y: 0, z: -1 },
      };
    },
  } as CollisionWorld;
  const state = new WorldState();
  const shooter = createPlayerEntity(entityId(1), playerId(1), { x: 0, y: 0, z: 0 });
  shooter.input!.buttons = InputButtons.FIRE | InputButtons.ALT_FIRE;
  state.addEntity(shooter);
  const projectiles = new ProjectileSystem(collision);
  projectiles.selfDamageMultiplier = multiplier;
  const weapons = new WeaponSystem();
  weapons.setCollisionWorld(collision);
  weapons.setProjectileSystem(projectiles);
  weapons.initializeWeaponFromLoadout(entityId(1), {
    weapons: ["plasmagun"],
    ammo: { plasmagun: 50 },
    health: 100,
    armor: 0,
  });
  weapons.update(state, 1 / 125, tickNumber(100));
  const spawn = [...state.entitiesByType(EntityType.Projectile)][0];
  expect(spawn).toBeDefined();
  const spawnPosition = { ...spawn.transform!.position };
  const impacts: ReturnType<ProjectileSystem["getPendingImpacts"]> = [];
  for (let i = 0; i < 10 && impacts.length === 0; i++) {
    projectiles.update(state, 1 / 125, tickNumber(100 + i));
    impacts.push(...projectiles.getPendingImpacts());
  }
  const damage = projectiles.getPendingDamage();
  const combat = new CombatSystem();
  for (const event of damage) combat.queueDamage(event);
  combat.update(state, 1 / 125, tickNumber(100));
  return {
    damage,
    impacts,
    spawnPosition,
    health: state.getEntity(entityId(1))!.health!.health,
  };
}

describe("plasma wall splash", () => {
  it("hurts its shooter near a wall with the shared splash falloff", () => {
    const result = fireAtWall(24);
    expect(result.spawnPosition.z).toBeLessThan(24);
    const impact = result.impacts[0];
    expect(impact).toBeDefined();
    const weapon = WEAPONS.plasmagun;
    const distance = Math.hypot(impact.x, impact.y, impact.z);
    const expected = Math.round(
      weapon.minSplashDamage! +
        (weapon.splashDamage! - weapon.minSplashDamage!) * (1 - distance / weapon.splashRadius!),
    );
    expect(result.damage).toEqual([
      expect.objectContaining({ victimId: entityId(1), damageType: DamageType.Explosion, damage: expected }),
    ]);
    expect(expected).toBeGreaterThan(0);
    expect(result.health).toBe(100 - expected);
  });

  it("respects the shared self-damage multiplier", () => {
    const full = fireAtWall(24).damage[0].damage;
    expect(fireAtWall(24, 0.5).damage[0].damage).toBe(Math.round(full * 0.5));
    expect(fireAtWall(24, 0).damage).toEqual([]);
  });

  it("does not hurt its shooter outside the small plasma splash radius", () => {
    const result = fireAtWall(80);
    expect(result.impacts).toHaveLength(1);
    expect(result.damage).toEqual([]);
  });
});
