import { Simulation } from "@engine/server/core/Simulation";
import { describe, expect, it } from "vitest";
import { Duel } from "../gametypes/Duel";
import { GametypeController } from "../gametypes/GametypeController";
import { buildSnapshot, type SnapshotContext } from "../SnapshotBuilder";
import { CombatSystem, DamageType, HitLocation, type ProcessedDamage } from "../systems/CombatSystem";
import { DroppedWeaponSystem } from "../systems/DroppedWeaponSystem";
import { PickupSystem } from "../systems/PickupSystem";
import { ProjectileSystem } from "../systems/ProjectileSystem";
import { WeaponSystem } from "../systems/WeaponSystem";

/**
 * The damage event is what the client turns into a floating number and a hit marker. It
 * names where the hit landed, so a head hit can look and sound different from a body hit.
 */
function snapshotWith(damage: ProcessedDamage[]) {
  const simulation = new Simulation({ tickMs: 8 });
  simulation.initialize();
  const combatSystem = new CombatSystem();
  (combatSystem as unknown as { processedDamage: ProcessedDamage[] }).processedDamage = damage;
  const ctx: SnapshotContext = {
    simulation,
    weaponSystem: new WeaponSystem(),
    projectileSystem: new ProjectileSystem(),
    combatSystem,
    pickupSystem: new PickupSystem(),
    droppedWeaponSystem: new DroppedWeaponSystem(),
    gametypeController: new GametypeController(new Duel()),
    clients: new Map(),
    botNames: new Map(),
    knownProjectileIds: new Set(),
    pendingKillEvents: [],
    pendingChatEvents: [],
    pendingAwards: [],
    needsPickupSync: new Set(),
  };
  return buildSnapshot(ctx).events.filter((event) => event.type === "damage");
}

const entry = (hitLocation: HitLocation, over: Partial<ProcessedDamage> = {}): ProcessedDamage => ({
  victimId: 7 as never,
  attackerId: 3 as never,
  damage: 11,
  damageType: DamageType.Bullet,
  hitLocation,
  x: 1,
  y: 2,
  z: 3,
  ...over,
});

describe("snapshot damage events", () => {
  it.each([HitLocation.Head, HitLocation.Body, HitLocation.Legs])("carry a %s hit's location", (location) => {
    const events = snapshotWith([entry(location)]);
    expect(events).toHaveLength(1);
    expect(events[0].hitLocation).toBe(location);
  });

  it("still carry everything they carried before", () => {
    const [event] = snapshotWith([entry(HitLocation.Head, { damage: 44 })]);
    expect(event).toMatchObject({ type: "damage", damage: 44, x: 1, y: 2, z: 3 });
    expect(event.entityId).toBeTruthy();
    expect(event.attackerId).toBeTruthy();
  });
});
