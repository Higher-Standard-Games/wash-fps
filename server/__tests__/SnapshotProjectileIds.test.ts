import { Simulation } from "@engine/server/core/Simulation";
import { createProjectileEntity } from "@engine/server/ecs/Entity";
import { entityId, playerId } from "@engine/server/ecs/types";
import { describe, expect, it } from "vitest";
import { Duel } from "../gametypes/Duel";
import { GametypeController } from "../gametypes/GametypeController";
import { buildSnapshot, type SnapshotContext } from "../SnapshotBuilder";
import { CombatSystem } from "../systems/CombatSystem";
import { DroppedWeaponSystem } from "../systems/DroppedWeaponSystem";
import { PickupSystem } from "../systems/PickupSystem";
import { ProjectileSystem } from "../systems/ProjectileSystem";
import { WeaponSystem } from "../systems/WeaponSystem";

/**
 * The snapshot builder remembers which projectiles it has already announced so a
 * projectile's spawn is sent once. Entity ids are never reused, so an id whose
 * projectile is gone can be forgotten, and the set must not grow for a whole match.
 */
function context(known: Set<number>): SnapshotContext {
  const simulation = new Simulation({ tickMs: 8 });
  simulation.initialize();
  return {
    simulation,
    weaponSystem: new WeaponSystem(),
    projectileSystem: new ProjectileSystem(),
    combatSystem: new CombatSystem(),
    pickupSystem: new PickupSystem(),
    droppedWeaponSystem: new DroppedWeaponSystem(),
    gametypeController: new GametypeController(new Duel()),
    clients: new Map(),
    botNames: new Map(),
    knownProjectileIds: known,
    pendingKillEvents: [],
    pendingChatEvents: [],
    pendingAwards: [],
    needsPickupSync: new Set(),
  };
}

describe("snapshot projectile bookkeeping", () => {
  it("forgets projectile ids whose projectile no longer exists", () => {
    const known = new Set([101, 102, 103]);

    buildSnapshot(context(known));

    expect(known.size).toBe(0);
  });

  it("keeps a live projectile's id and drops it once the projectile is gone", () => {
    const known = new Set<number>();
    const ctx = context(known);
    const state = ctx.simulation.getStateMut();
    const rocket = createProjectileEntity(entityId(7), playerId(1), { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 100 });
    state.addEntity(rocket);

    buildSnapshot(ctx);
    expect(known.has(7)).toBe(true);

    buildSnapshot(ctx);
    expect(known.has(7)).toBe(true); // still in flight: not forgotten, so not announced twice

    state.removeEntity(entityId(7));
    buildSnapshot(ctx);
    expect(known.has(7)).toBe(false);
  });

  it("builds an empty world without error", () => {
    const state = buildSnapshot(context(new Set()));
    expect(state.entities.size).toBe(0);
  });
});
