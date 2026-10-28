/**
 * ItemThrow over the real SweepCollisionBackend and a synthetic BSP. A map
 * weapon's pickup trigger has to be where the weapon comes to rest, so every
 * side must throw it identically and follow it wherever it lands.
 *
 * WORLD (Q3 coords, z up; the collision API is Babylon, y up):
 *   floor     z <= 0 everywhere
 *   platform  x <= 0, top at z = 128, so there is a ledge at x = 0
 */

import { describe, expect, it } from "vitest";
import type { BspBrushSide, BspFile, BspPlane } from "../../../../../engine/loader/bsp/BspLoader";
import { ContentFlags } from "../../../../../engine/physics/ContentFlags";
import { SweepBackendAdapter } from "../../../../../engine/physics/SweepBackendAdapter";
import { SweepCollisionBackend } from "../../../../../engine/physics/SweepCollisionBackend";
import type { CollisionWorld } from "../../../../../shared/collision/CollisionWorld";
import { SharedCollisionWorld } from "../../../../../shared/collision/SharedCollisionWorld";
import type { PickupEntry } from "../../bsp/PickupTable";
import {
  DROPPED_WEAPON_BOUNCE,
  landMapPickups,
  landThrownItem,
  mapWeaponTossVelocity,
  stepThrownItem,
  type ThrownItem,
} from "../ItemThrow";

type Triple = [number, number, number];

interface BoxSpec {
  min: Triple;
  max: Triple;
  name: string;
  contentFlags: number;
}

function boxPlanes(min: Triple, max: Triple): BspPlane[] {
  return [
    { normal: [1, 0, 0], dist: max[0] },
    { normal: [-1, 0, 0], dist: -min[0] },
    { normal: [0, 1, 0], dist: max[1] },
    { normal: [0, -1, 0], dist: -min[1] },
    { normal: [0, 0, 1], dist: max[2] },
    { normal: [0, 0, -1], dist: -min[2] },
  ];
}

function buildBsp(boxes: BoxSpec[]): BspFile {
  const planes: BspPlane[] = [];
  const brushSides: BspBrushSide[] = [];
  const brushes: BspFile["brushes"] = [];
  const textures: BspFile["textures"] = [];
  const leafBrushes: number[] = [];

  boxes.forEach((box, i) => {
    textures.push({ name: box.name, contentFlags: box.contentFlags, surfaceFlags: 0 });
    const firstSide = brushSides.length;
    for (const p of boxPlanes(box.min, box.max)) {
      brushSides.push({ planeIndex: planes.length, shaderIndex: i });
      planes.push(p);
    }
    brushes.push({ firstSide, numSides: 6, shaderIndex: i });
    leafBrushes.push(i);
  });

  const big: Triple = [1e6, 1e6, 1e6];
  const negBig: Triple = [-1e6, -1e6, -1e6];
  return {
    header: { isFBSP: false },
    lumps: [],
    entities: [],
    textures,
    planes,
    nodes: [{ planeIndex: 0, children: [-1, -1] as [number, number], mins: negBig, maxs: big }],
    leafs: [
      {
        cluster: 0,
        area: 0,
        mins: negBig,
        maxs: big,
        firstLeafFace: 0,
        numLeafFaces: 0,
        firstLeafBrush: 0,
        numLeafBrushes: leafBrushes.length,
      },
    ],
    leafFaces: [],
    leafBrushes,
    models: [],
    brushes,
    brushSides,
    vertices: [],
    meshVerts: [],
    effects: [],
    faces: [],
    lightmaps: [],
    lightVols: [],
    visData: null,
    lightmapSize: 128,
  } as unknown as BspFile;
}

async function world(boxes: BoxSpec[]): Promise<CollisionWorld> {
  const backend = new SweepCollisionBackend();
  await backend.init(buildBsp(boxes));
  return new SharedCollisionWorld(new SweepBackendAdapter(backend));
}

const FLOOR: BoxSpec = {
  min: [-4000, -4000, -4000],
  max: [4000, 4000, 0],
  name: "floor",
  contentFlags: ContentFlags.SOLID,
};
const PLATFORM: BoxSpec = {
  min: [-4000, -4000, 0],
  max: [0, 4000, 128],
  name: "platform",
  contentFlags: ContentFlags.SOLID,
};
const level = () => world([FLOOR, PLATFORM]);

const weapon = (id: number, position: { x: number; y: number; z: number }): PickupEntry => ({
  id,
  classname: "weapon_rocketlauncher",
  type: "weapon",
  kind: "rlauncher",
  position,
});

/** A thrown item rests on the floor it lands on: above its top, within its 8u box. */
const expectRestingOn = (y: number | undefined, floorTop: number) => {
  expect(y).toBeGreaterThan(floorTop);
  expect(y).toBeLessThan(floorTop + 8);
};

describe("mapWeaponTossVelocity", () => {
  it("pops every weapon up and scatters it a little, the same way for the same id", () => {
    for (const id of [0, 1, 7, 42]) {
      const velocity = mapWeaponTossVelocity(id);
      expect(velocity).toEqual(mapWeaponTossVelocity(id));
      expect(velocity.y).toBe(95);
      const horizontal = Math.hypot(velocity.x, velocity.z);
      expect(horizontal).toBeGreaterThanOrEqual(22 * 0.35 - 1e-9);
      expect(horizontal).toBeLessThanOrEqual(22 + 1e-9);
    }
  });
});

describe("landThrownItem", () => {
  it("carries a thrown item over an edge and reports where it settles below", async () => {
    const rest = landThrownItem({ x: -8, y: 132, z: 0 }, { x: 120, y: 95, z: 0 }, await level());

    expect(rest).not.toBeNull();
    expect(rest?.x).toBeGreaterThan(4);
    expectRestingOn(rest?.y, 0);
  });

  it("returns null for a throw that never comes to rest", async () => {
    const collision = await world([{ ...FLOOR, min: [5000, 5000, -10], max: [5100, 5100, 0] }]);

    expect(landThrownItem({ x: 0, y: 500, z: 0 }, { x: 0, y: 0, z: 0 }, collision)).toBeNull();
  });
});

describe("dropped weapon bounce", () => {
  it("bounces off the floor a few times, each lower, then comes to rest; without it lands dead", async () => {
    const collision = await level();
    const throwFrom = (bounce?: number) => {
      const item: ThrownItem = {
        position: { x: 400, y: 120, z: 0 },
        velocity: { x: 60, y: 200, z: 0 },
        settled: false,
        bounce,
      };
      const peaks: number[] = [];
      let rising = true;
      for (let step = 0; step < 5 * 125 && !item.settled; step++) {
        const before = item.velocity.y;
        stepThrownItem(item, collision);
        if (before < -20 && item.velocity.y > 20) rising = true;
        if (rising && item.velocity.y <= 0) {
          peaks.push(item.position.y);
          rising = false;
        }
      }
      return { item, peaks };
    };

    const bounced = throwFrom(DROPPED_WEAPON_BOUNCE);
    expect(bounced.item.settled).toBe(true);
    expectRestingOn(bounced.item.position.y, 0);
    // The throw's own peak, then lower and lower bounces
    expect(bounced.peaks.length).toBeGreaterThan(1);
    for (let i = 1; i < bounced.peaks.length; i++) expect(bounced.peaks[i]).toBeLessThan(bounced.peaks[i - 1]);

    const dead = throwFrom();
    expect(dead.item.settled).toBe(true);
    expect(dead.peaks).toHaveLength(1);
  });
});

describe("landMapPickups", () => {
  it("brings a weapon to rest on the floor beside its authored spot", async () => {
    const [landed] = landMapPickups([weapon(7, { x: -400, y: 152, z: 0 })], await level());

    expectRestingOn(landed.position.y, 128);
    expect(Math.hypot(landed.position.x + 400, landed.position.z)).toBeLessThan(16);
  });

  it("moves the pickup with a weapon that comes to rest on the level below", async () => {
    const [landed] = landMapPickups([weapon(7, { x: 40, y: 152, z: 0 })], await level());

    expectRestingOn(landed.position.y, 0);
  });

  it("keeps a weapon's authored spot when its throw never settles", async () => {
    const authored = weapon(7, { x: 0, y: 500, z: 0 });
    const collision = await world([{ ...FLOOR, min: [5000, 5000, -10], max: [5100, 5100, 0] }]);

    expect(landMapPickups([authored], collision)[0]).toBe(authored);
  });

  it("drops armor, health, ammo and powerups straight onto the floor beneath them", async () => {
    // Authored 80 units above the floor, as the red armor on wdm17 is: a trigger
    // left there was out of reach of a player standing where the item is drawn
    const at = { x: -400, y: 208, z: 0 };
    const entries: PickupEntry[] = [
      { id: 0, classname: "item_armor_ra", type: "armor", kind: "ra", position: at },
      { id: 1, classname: "item_health_mega", type: "health", kind: "mega", position: at },
      { id: 2, classname: "ammo_rockets", type: "ammo", kind: "rockets", amount: 10, position: at },
      { id: 3, classname: "item_quad", type: "powerup", kind: "quad", position: at },
    ];

    for (const landed of landMapPickups(entries, await level())) {
      expectRestingOn(landed.position.y, 128);
      expect(landed.position.x).toBe(-400);
      expect(landed.position.z).toBe(0);
    }
  });

  it("keeps an item the map marks suspended where it hangs", async () => {
    const hanging: PickupEntry = {
      id: 0,
      classname: "item_quad",
      type: "powerup",
      kind: "quad",
      position: { x: -400, y: 208, z: 0 },
      suspended: true,
    };

    expect(landMapPickups([hanging], await level())[0]).toBe(hanging);
  });

  it("lands every weapon identically in two separately built collision worlds, as client and server do", async () => {
    const entries = [
      weapon(0, { x: -400, y: 152, z: 0 }),
      weapon(7, { x: -12, y: 136, z: 300 }),
      weapon(13, { x: 40, y: 152, z: 0 }),
    ];

    const client = landMapPickups(entries, await level());
    const server = landMapPickups(entries, await level());

    expect(client).not.toEqual(entries);
    expect(client).toStrictEqual(server);
  });

  it("returns the table unchanged without a collision world", () => {
    const entries = [weapon(7, { x: -400, y: 152, z: 0 })];

    expect(landMapPickups(entries, null)).toEqual(entries);
  });
});
