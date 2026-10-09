/**
 * Machinegun spread and the riotgun's pellet seed on the server.
 *
 * The machinegun had `spread` values that nothing read: the single-ray path aimed
 * exactly down the view. It now picks one deviation per shot inside a cone that
 * blooms open under sustained fire, and the fire event carries that direction, so
 * every client draws the tracer where the damage ray went. The riotgun's fire
 * event carries the pellet seed and cone, so clients draw the server's pellets.
 */

import { EntityType } from "@engine/server/ecs/types";
import { describe, expect, it } from "vitest";
import { DEFAULT_VIEWHEIGHT } from "../../../../../engine/physics/PlayerPhysicsConstants";
import { MACHINEGUN } from "../../../../../shared/entities/definitions/weapons/machinegun";
import { RIOTGUN } from "../../../../../shared/entities/definitions/weapons/riotgun";
import { generateSpreadDirections, yawPitchFromDirection } from "../../../../../shared/SpreadUtils";
import { fireIntervalTicks, WeaponSystem } from "../WeaponSystem";

const FIRE_BUTTON = 1 << 8;
const ALT_FIRE_BUTTON = 1 << 9;
const INTERVAL = fireIntervalTicks(MACHINEGUN);

function makeShooter(buttons = FIRE_BUTTON, yaw = 0.3, pitch = -0.1) {
  return {
    id: 1,
    ownerId: 1,
    transform: { position: { x: 0, y: 0, z: 0 } },
    input: { buttons, yaw, pitch, weaponSlot: 0 },
    health: { dead: false, health: 100, armor: 0, maxHealth: 100, maxArmor: 100 },
  };
}

function makeState(entities: unknown[]) {
  return {
    entitiesByType: (t: EntityType) => (t === EntityType.Player ? entities : []),
    getEntity: (id: number) => entities.find((e) => (e as { id: number }).id === id),
    getEntityMut: (id: number) => entities.find((e) => (e as { id: number }).id === id),
    addEntity: () => {},
    removeEntity: () => {},
  };
}

function armed(weapon: string) {
  const sys = new WeaponSystem();
  sys.initializeWeaponFromLoadout(
    1 as never,
    { weapons: [weapon], ammo: { [weapon]: 999 }, health: 100, armor: 0 } as never,
  );
  return sys;
}

function lookOf(yaw: number, pitchInput: number) {
  const pitch = -pitchInput;
  return { x: Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: Math.cos(yaw) * Math.cos(pitch) };
}

/** Degrees between a fire event's direction and the shooter's look. */
function deviation(fire: { dirX: number; dirY: number; dirZ: number }, yaw = 0.3, pitch = -0.1): number {
  const look = lookOf(yaw, pitch);
  const dot = fire.dirX * look.x + fire.dirY * look.y + fire.dirZ * look.z;
  return (Math.acos(Math.min(1, dot)) * 180) / Math.PI;
}

/** Hold the trigger for `shots` shots; the fire event of each. */
function burst(sys: WeaponSystem, shots: number, buttons = FIRE_BUTTON, firstTick = 1000) {
  const shooter = makeShooter(buttons);
  const fires = [];
  for (let i = 0; i < shots; i++) {
    sys.update(makeState([shooter]) as never, 1 / 125, (firstTick + i * INTERVAL) as never);
    fires.push(...sys.getPendingFireEvents());
  }
  return fires;
}

describe("machinegun spread", () => {
  it("keeps every shot inside the cone, tight at first and opening up under sustained fire", () => {
    const fires = burst(armed("machinegun"), 24);
    expect(fires).toHaveLength(24);
    const angles = fires.map((fire) => deviation(fire));
    const bloom = MACHINEGUN.spreadBloom!;

    expect(angles[0]).toBeLessThanOrEqual(MACHINEGUN.spread! + 1e-6);
    for (const angle of angles) expect(angle).toBeLessThanOrEqual(bloom.maxSpread + 1e-6);
    // Some shot after the first few goes wider than the cold cone allows.
    expect(Math.max(...angles.slice(bloom.shotsToMax))).toBeGreaterThan(MACHINEGUN.spread!);
    // And no two shots in a row go the same way.
    expect(new Set(angles.map((a) => a.toFixed(6))).size).toBe(angles.length);
  });

  it("closes again once the trigger has been off for the recovery time", () => {
    const sys = armed("machinegun");
    burst(sys, 12);
    const rested = 1000 + 12 * INTERVAL + Math.ceil(MACHINEGUN.spreadBloom!.recoverySeconds * 125) + 10;
    const [next] = burst(sys, 1, FIRE_BUTTON, rested);
    expect(deviation(next)).toBeLessThanOrEqual(MACHINEGUN.spread! + 1e-6);
  });

  it("stays tight when aimed", () => {
    const fires = burst(armed("machinegun"), 24, FIRE_BUTTON | ALT_FIRE_BUTTON);
    const angles = fires.map((fire) => deviation(fire));
    expect(angles[0]).toBeLessThanOrEqual(MACHINEGUN.adsSpread! + 1e-6);
    for (const angle of angles) expect(angle).toBeLessThanOrEqual(MACHINEGUN.spreadBloom!.adsMaxSpread + 1e-6);
  });

  it("is the same shot for the same tick and shooter (demos and the re-sim reproduce it)", () => {
    const a = burst(armed("machinegun"), 6);
    const b = burst(armed("machinegun"), 6);
    expect(a.map((f) => [f.dirX, f.dirY, f.dirZ])).toEqual(b.map((f) => [f.dirX, f.dirY, f.dirZ]));
  });

  it("damages along the fire event's direction, the one every client draws", () => {
    // Where the shot goes, from a system with nothing to hit.
    const [fire] = burst(armed("machinegun"), 1);
    expect(deviation(fire)).toBeGreaterThan(0);

    // A small target far down that direction, out past where the plain look ray could reach it.
    const distance = 3000;
    const target = {
      id: 2,
      transform: {
        position: {
          x: fire.dirX * distance,
          y: DEFAULT_VIEWHEIGHT + fire.dirY * distance,
          z: fire.dirZ * distance,
        },
      },
      health: { dead: false, health: 100, armor: 0, maxHealth: 100, maxArmor: 100 },
    };
    const sys = armed("machinegun");
    sys.update(makeState([makeShooter(), target]) as never, 1 / 125, 1000 as never);
    expect(sys.getPendingDamage().map((d) => d.victimId)).toContain(2);
  });
});

describe("riotgun pellet seed", () => {
  it("puts the seed and cone in the fire event, and they rebuild the server's pellets", () => {
    const [fire] = burst(armed("riotgun"), 1);
    expect(fire.pelletSeed).toBeTypeOf("number");
    expect(fire.pelletSpread).toBe(RIOTGUN.spread);

    // The server's call, from the shooter's input...
    const server = generateSpreadDirections(fire.pelletSeed!, RIOTGUN.pelletCount!, fire.pelletSpread!, 0.3, -0.1);
    // ...and a client's, from the event alone.
    const { yaw, pitch } = yawPitchFromDirection({ x: fire.dirX, y: fire.dirY, z: fire.dirZ });
    const client = generateSpreadDirections(fire.pelletSeed!, RIOTGUN.pelletCount!, fire.pelletSpread!, yaw, pitch);

    expect(client).toHaveLength(RIOTGUN.pelletCount!);
    for (let i = 0; i < server.length; i++) {
      expect(client[i].x).toBeCloseTo(server[i].x, 9);
      expect(client[i].y).toBeCloseTo(server[i].y, 9);
      expect(client[i].z).toBeCloseTo(server[i].z, 9);
    }
  });

  it("sends the aimed cone when aimed", () => {
    const [fire] = burst(armed("riotgun"), 1, FIRE_BUTTON | ALT_FIRE_BUTTON);
    expect(fire.pelletSpread).toBe(RIOTGUN.adsSpread);
  });

  it("leaves single-ray shots without a seed", () => {
    const [fire] = burst(armed("machinegun"), 1);
    expect(fire.pelletSeed).toBeUndefined();
  });
});
