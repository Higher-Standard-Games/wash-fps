/**
 * EntityManager map pickup placement. All client visuals use the shared resting
 * position of the server trigger, matched by pickup id and authored origin.
 *
 * WORLD (Q3 coords, z up): floor z <= 0; platform x <= 0 with its top at z = 128.
 */

import type { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BspBrushSide, BspFile, BspPlane } from "../../../../engine/loader/bsp/BspLoader";
import { CollisionManager } from "../../../../engine/physics/CollisionManager";
import { ContentFlags } from "../../../../engine/physics/ContentFlags";
import { SweepBackendAdapter } from "../../../../engine/physics/SweepBackendAdapter";
import { SweepCollisionBackend } from "../../../../engine/physics/SweepCollisionBackend";
import { extractPickups } from "../../../../shared/bsp/PickupTable";
import { SharedCollisionWorld } from "../../../../shared/collision/SharedCollisionWorld";
import type { EntityDef } from "../../../../shared/entities/EntityDef";
import { EntityType } from "../../../../shared/entities/EntityType";
import { landMapPickups } from "../../../../shared/items/ItemThrow";
import { EntityManager } from "../EntityManager";

type Spawned = { position: { x: number; y: number; z: number }; options: Record<string, unknown> };
const spawned = vi.hoisted(() => [] as Spawned[]);

vi.mock("../FPSPickup", () => ({
  FPSPickup: class {
    constructor(_name: string, _scene: unknown, position: Spawned["position"], options: Spawned["options"]) {
      spawned.push({ position: { x: position.x, y: position.y, z: position.z }, options });
    }
    whenReady() {
      return Promise.resolve();
    }
    dispose() {}
  },
}));

type Triple = [number, number, number];

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

async function sweepBackend(): Promise<SweepCollisionBackend> {
  const boxes: Array<[Triple, Triple]> = [
    [
      [-4000, -4000, -4000],
      [4000, 4000, 0],
    ],
    [
      [-4000, -4000, 0],
      [0, 4000, 128],
    ],
  ];
  const planes: BspPlane[] = [];
  const brushSides: BspBrushSide[] = [];
  boxes.forEach(([min, max], i) => {
    for (const plane of boxPlanes(min, max)) {
      brushSides.push({ planeIndex: planes.length, shaderIndex: i });
      planes.push(plane);
    }
  });
  const big: Triple = [1e6, 1e6, 1e6];
  const negBig: Triple = [-1e6, -1e6, -1e6];
  const bsp = {
    header: { isFBSP: false },
    lumps: [],
    entities: [],
    textures: boxes.map((_, i) => ({ name: `box${i}`, contentFlags: ContentFlags.SOLID, surfaceFlags: 0 })),
    planes,
    nodes: [{ planeIndex: 0, children: [-1, -1], mins: negBig, maxs: big }],
    leafs: [
      {
        cluster: 0,
        area: 0,
        mins: negBig,
        maxs: big,
        firstLeafFace: 0,
        numLeafFaces: 0,
        firstLeafBrush: 0,
        numLeafBrushes: boxes.length,
      },
    ],
    leafFaces: [],
    leafBrushes: boxes.map((_, i) => i),
    models: [],
    brushes: boxes.map((_, i) => ({ firstSide: i * 6, numSides: 6, shaderIndex: i })),
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
  const backend = new SweepCollisionBackend();
  await backend.init(bsp);
  return backend;
}

const ROCKET_LAUNCHER = {
  id: "rlauncher",
  name: "Rocket Launcher",
  classname: "weapon_rocketlauncher",
  type: EntityType.WEAPON,
  modelPath: "/data/models/weapons/rlauncher/rlauncher.glb",
  scale: 2,
} as EntityDef;

/** One launcher on the platform, one authored over the lower floor at platform height. */
type MapEntity = { classname: string; properties: Record<string, string> };
const ENTITIES: MapEntity[] = [
  { classname: "weapon_rocketlauncher", properties: { origin: "-400 0 152" } },
  { classname: "weapon_rocketlauncher", properties: { origin: "40 0 152" } },
];

type Internals = {
  rebuildPickupTable(entities: MapEntity[]): void;
  spawnEntity(def: EntityDef, data: MapEntity, scene: Scene): Promise<unknown>;
};

const manager = () => EntityManager.getInstance() as unknown as Internals;

beforeEach(() => {
  spawned.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  EntityManager.getInstance().disposeMapEntities();
  vi.restoreAllMocks();
});

describe("EntityManager map pickup placement", () => {
  it("draws each map weapon where the server's trigger is, with no physics toss", async () => {
    vi.spyOn(CollisionManager.getInstance(), "getSweepBackend").mockReturnValue(await sweepBackend());
    manager().rebuildPickupTable(ENTITIES);
    for (const entity of ENTITIES) await manager().spawnEntity(ROCKET_LAUNCHER, entity, {} as Scene);

    // What the server and bots compute in their own collision world.
    const server = landMapPickups(
      extractPickups(ENTITIES),
      new SharedCollisionWorld(new SweepBackendAdapter(await sweepBackend())),
    );

    expect(spawned).toHaveLength(2);
    spawned.forEach(({ position, options }, i) => {
      expect(options.pickupId).toBe(server[i].id);
      expect(options.velocity).toBeUndefined();
      expect(Number.isFinite(options.yaw)).toBe(true);
      expect(position.x).toBe(server[i].position.x);
      expect(position.z).toBe(server[i].position.z);
      // Placed exactly where the trigger is, and marked as already resting there:
      // a floor raycast on top of this is a client-only guess that can disagree.
      expect(position.y).toBe(server[i].position.y);
      expect(options.landedOnFloor).toBe(true);
    });
    // The second launcher came to rest on the lower floor (top y = 0), not the platform.
    expect(server[1].position.y).toBeGreaterThan(0);
    expect(server[1].position.y).toBeLessThan(8);
  });

  it("keeps authored spots, and says so, when collision is not ready", async () => {
    vi.spyOn(CollisionManager.getInstance(), "getSweepBackend").mockReturnValue(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    manager().rebuildPickupTable(ENTITIES);
    await manager().spawnEntity(ROCKET_LAUNCHER, ENTITIES[0], {} as Scene);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Collision is not ready"));
    // The authored origin, lifted clear of the floor to raycast down from.
    expect(spawned[0].position).toEqual({ x: -400, y: 152 + 24, z: 0 });
    // No landing was computed, so the authored spot is a guess: let the pickup
    // find the floor beneath it as it always did.
    expect(spawned[0].options.landedOnFloor).toBe(false);
  });

  it("draws armor and mega health at the server's landed trigger, and preserves suspended items", async () => {
    const entities: MapEntity[] = [
      { classname: "item_armor_ya", properties: { origin: "-400 0 152" } },
      { classname: "item_health_mega", properties: { origin: "40 0 152" } },
      { classname: "item_armor_ya", properties: { origin: "100 0 152", spawnflags: "1" } },
    ];
    const armor = {
      id: "armor_ya",
      name: "Yellow Armor",
      classname: "item_armor_ya",
      type: EntityType.ARMOR,
    } as EntityDef;
    const mega = {
      id: "health_mega",
      name: "Mega Health",
      classname: "item_health_mega",
      type: EntityType.HEALTH,
    } as EntityDef;
    vi.spyOn(CollisionManager.getInstance(), "getSweepBackend").mockReturnValue(await sweepBackend());
    manager().rebuildPickupTable(entities);
    for (const entity of entities) {
      await manager().spawnEntity(entity.classname === "item_health_mega" ? mega : armor, entity, {} as Scene);
    }

    const server = landMapPickups(
      extractPickups(entities),
      new SharedCollisionWorld(new SweepBackendAdapter(await sweepBackend())),
    );
    expect(spawned).toHaveLength(3);
    spawned.forEach(({ position, options }, i) => {
      expect(options.pickupId).toBe(server[i].id);
      expect(options.landedOnFloor).toBe(true);
      expect(position).toEqual(server[i].position);
    });
    expect(server[0].position.y).toBeLessThan(152);
    expect(server[1].position.y).toBeLessThan(152);
    expect(server[2].position.y).toBe(152);
  });

  it("keeps a suspended non-weapon at its authored origin without collision", async () => {
    const entity: MapEntity = { classname: "item_armor_ya", properties: { origin: "100 0 152", spawnflags: "1" } };
    const armor = {
      id: "armor_ya",
      name: "Yellow Armor",
      classname: "item_armor_ya",
      type: EntityType.ARMOR,
    } as EntityDef;
    vi.spyOn(CollisionManager.getInstance(), "getSweepBackend").mockReturnValue(null);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    manager().rebuildPickupTable([entity]);
    await manager().spawnEntity(armor, entity, {} as Scene);
    expect(spawned[0].position).toEqual({ x: 100, y: 152, z: 0 });
    expect(spawned[0].options.landedOnFloor).toBe(true);
  });
});
