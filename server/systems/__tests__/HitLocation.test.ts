import { EntityType } from "@engine/server/ecs/types";
import { describe, expect, it } from "vitest";
import { DEFAULT_VIEWHEIGHT } from "../../../../../engine/physics/PlayerPhysicsConstants";
import {
  CombatSystem,
  classifyHitLocation,
  DamageType,
  HEAD_DAMAGE_MULTIPLIER,
  HEAD_MIN_OFFSET,
  HitLocation,
  LEGS_DAMAGE_MULTIPLIER,
  LEGS_MAX_OFFSET,
} from "../CombatSystem";
import { WeaponSystem } from "../WeaponSystem";

/**
 * Where a hit lands decides how much it does: a head hit does 10% more, a leg hit 25% less.
 *
 * The hit test is a sphere of radius 32 around the target's origin, and a hit is classified
 * by the height of the ray's closest point to that origin. The head threshold used to be 32,
 * which that height can never exceed, so head hits never registered for hitscan weapons.
 */
describe("classifying a hit by height", () => {
  it("puts the middle of the body in the body band", () => {
    expect(classifyHitLocation(0)).toBe(HitLocation.Body);
    expect(classifyHitLocation(HEAD_MIN_OFFSET)).toBe(HitLocation.Body); // the edge itself is body
    expect(classifyHitLocation(LEGS_MAX_OFFSET)).toBe(HitLocation.Body);
  });

  it("calls anything above the head threshold a head hit", () => {
    expect(classifyHitLocation(HEAD_MIN_OFFSET + 1)).toBe(HitLocation.Head);
    expect(classifyHitLocation(31)).toBe(HitLocation.Head);
  });

  it("calls anything below the legs threshold a leg hit", () => {
    expect(classifyHitLocation(LEGS_MAX_OFFSET - 1)).toBe(HitLocation.Legs);
    expect(classifyHitLocation(-31)).toBe(HitLocation.Legs);
  });

  it("keeps the head threshold inside what a sphere hit can reach", () => {
    // The closest point of a ray that hits a radius-32 sphere is always within 32 of its centre.
    expect(HEAD_MIN_OFFSET).toBeLessThan(32);
    expect(LEGS_MAX_OFFSET).toBeGreaterThan(-32);
  });

  it("makes a head hit worth 10% more", () => {
    expect(HEAD_DAMAGE_MULTIPLIER).toBeCloseTo(1.1, 10);
  });
});

describe("merging damage that lands as one number", () => {
  function combatWithVictim() {
    const combat = new CombatSystem();
    combat.setMovementSubsystem({ queueImpulse: () => {} } as never);
    const victim = {
      id: 1,
      health: { health: 1000, armor: 0, dead: false, maxHealth: 1000, maxArmor: 100 },
      transform: { position: { x: 0, y: 0, z: 0 } },
      physics: { velocity: { x: 0, y: 0, z: 0 } },
      powerups: { expiry: {} },
    };
    const attacker = { ...victim, id: 2, health: { ...victim.health }, powerups: { expiry: {} } };
    const byId = new Map<number, unknown>([
      [1, victim],
      [2, attacker],
    ]);
    const state = { getEntityMut: (id: number) => byId.get(id), getEntity: (id: number) => byId.get(id) };
    const pellet = (hitLocation: HitLocation) =>
      combat.queueDamage({
        victimId: 1 as never,
        attackerId: 2 as never,
        damage: 10,
        armorPiercing: 0,
        damageType: DamageType.Bullet,
        hitLocation,
        knockbackDir: { x: 1, y: 0, z: 0 },
      });
    return { combat, state, pellet };
  }

  it("reports a head hit when any pellet hit the head, and adds the damage up", () => {
    const { combat, state, pellet } = combatWithVictim();
    pellet(HitLocation.Body);
    pellet(HitLocation.Head);
    pellet(HitLocation.Legs);
    combat.update(state as never, 0.008, 5 as never);

    const processed = combat.getProcessedDamage();
    expect(processed).toHaveLength(1);
    expect(processed[0].hitLocation).toBe(HitLocation.Head);
    expect(processed[0].damage).toBe(
      10 + Math.round(10 * HEAD_DAMAGE_MULTIPLIER) + Math.round(10 * LEGS_DAMAGE_MULTIPLIER),
    );
  });

  it("reports a leg hit over a body hit", () => {
    const { combat, state, pellet } = combatWithVictim();
    pellet(HitLocation.Body);
    pellet(HitLocation.Legs);
    combat.update(state as never, 0.008, 5 as never);
    expect(combat.getProcessedDamage()[0].hitLocation).toBe(HitLocation.Legs);
  });

  it("reports body for a single ordinary hit", () => {
    const { combat, state, pellet } = combatWithVictim();
    pellet(HitLocation.Body);
    combat.update(state as never, 0.008, 5 as never);
    expect(combat.getProcessedDamage()[0].hitLocation).toBe(HitLocation.Body);
  });
});

/**
 * The whole path through the weapon: a machinegun fired level from eye height at a target
 * whose origin is `offset` units below the ray, so the shot meets the target `offset` units
 * above its origin. The target is close (100 units), so the weapon's small spread moves
 * the point of impact by only a few units.
 */
describe("a real hitscan shot", () => {
  const FIRE_BUTTON = 1 << 8;
  const entity = (id: number, over: Record<string, unknown> = {}) => ({
    id,
    ownerId: id,
    health: { dead: false, health: 100, armor: 0, maxHealth: 100, maxArmor: 100 },
    ...over,
  });

  function shootAt(offset: number) {
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(
      1 as never,
      {
        weapons: ["machinegun"],
        ammo: { machinegun: 160 },
        health: 100,
        armor: 0,
      } as never,
    );
    const shooter = entity(1, {
      transform: { position: { x: 0, y: 0, z: 0 } },
      input: { buttons: FIRE_BUTTON, yaw: 0, pitch: 0, weaponSlot: 0 },
    });
    const target = entity(2, { transform: { position: { x: 0, y: DEFAULT_VIEWHEIGHT - offset, z: 100 } } });
    const players = [shooter, target];
    const state = {
      entitiesByType: (type: EntityType) => (type === EntityType.Player ? players : []),
      getEntity: (id: number) => players.find((e) => e.id === id),
      getEntityMut: (id: number) => players.find((e) => e.id === id),
      addEntity: () => {},
      removeEntity: () => {},
    };
    sys.update(state as never, 1 / 125, 100 as never);
    return sys.getPendingDamage();
  }

  it("scores a shot at the top of the body as a head hit", () => {
    const hits = shootAt(28);
    expect(hits).toHaveLength(1);
    expect(hits[0].hitLocation).toBe(HitLocation.Head);
  });

  it("scores a shot through the middle as a body hit", () => {
    const hits = shootAt(0);
    expect(hits).toHaveLength(1);
    expect(hits[0].hitLocation).toBe(HitLocation.Body);
  });

  it("scores a shot at the bottom of the body as a leg hit", () => {
    const hits = shootAt(-28);
    expect(hits).toHaveLength(1);
    expect(hits[0].hitLocation).toBe(HitLocation.Legs);
  });

  it("counts the head hit in the shooter's accuracy telemetry", () => {
    const sys = new WeaponSystem();
    sys.initializeWeaponFromLoadout(
      1 as never,
      {
        weapons: ["machinegun"],
        ammo: { machinegun: 160 },
        health: 100,
        armor: 0,
      } as never,
    );
    const shooter = entity(1, {
      transform: { position: { x: 0, y: 0, z: 0 } },
      input: { buttons: FIRE_BUTTON, yaw: 0, pitch: 0, weaponSlot: 0 },
    });
    const target = entity(2, { transform: { position: { x: 0, y: DEFAULT_VIEWHEIGHT - 28, z: 100 } } });
    const players = [shooter, target];
    sys.update(
      {
        entitiesByType: (type: EntityType) => (type === EntityType.Player ? players : []),
        getEntity: (id: number) => players.find((e) => e.id === id),
        getEntityMut: (id: number) => players.find((e) => e.id === id),
        addEntity: () => {},
        removeEntity: () => {},
      } as never,
      1 / 125,
      100 as never,
    );
    expect(sys.getAccuracy(1 as never)).toMatchObject({ shots: 1, hits: 1, headshots: 1 });
  });
});
