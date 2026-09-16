/**
 * DroppedWeaponSystem lifetime regression.
 *
 * QA-WO12 flipped every subsystem's `CONFIG.tickRate` from 125 to 0 ("run every
 * base tick"). DroppedWeaponSystem still derived its timers from that field, so
 * `despawnTicks = DESPAWN_TIME * 0 = 0` and `dt = 1 / 0 = Infinity`: a dropped
 * weapon was removed the same tick it spawned (never serialized to clients) —
 * the "swap makes the old weapon just disappear" bug. These lock the fix.
 */
import { describe, expect, it } from "vitest";
import type { BspBrushSide, BspFile, BspPlane } from "../../../../../engine/loader/bsp/BspLoader";
import { ContentFlags } from "../../../../../engine/physics/ContentFlags";
import { SweepBackendAdapter } from "../../../../../engine/physics/SweepBackendAdapter";
import { SweepCollisionBackend } from "../../../../../engine/physics/SweepCollisionBackend";
import { SharedCollisionWorld } from "../../../../../shared/collision/SharedCollisionWorld";
import { landThrownItem } from "../../../../../shared/items/ItemThrow";
import { DroppedWeaponSystem } from "../DroppedWeaponSystem";

interface StubEntity {
  id: number;
  transform?: { position: { x: number; y: number; z: number } };
}

function makeStubState() {
  const entities = new Map<number, StubEntity>();
  const state = {
    addEntity: (e: StubEntity) => entities.set(e.id, e),
    getEntity: (id: number) => entities.get(id),
    removeEntity: (id: number) => entities.delete(id),
    // biome-ignore lint/suspicious/noExplicitAny: minimal WorldState stub for this system
  } as any;
  return { state, entities };
}

/** A solid floor with its top at Q3 z = 0, as the real SweepCollisionBackend sees a BSP. */
async function floor() {
  const planes: BspPlane[] = [
    { normal: [1, 0, 0], dist: 4000 },
    { normal: [-1, 0, 0], dist: 4000 },
    { normal: [0, 1, 0], dist: 4000 },
    { normal: [0, -1, 0], dist: 4000 },
    { normal: [0, 0, 1], dist: 0 },
    { normal: [0, 0, -1], dist: 4000 },
  ];
  const brushSides: BspBrushSide[] = planes.map((_, planeIndex) => ({ planeIndex, shaderIndex: 0 }));
  const bounds: [number, number, number] = [1e6, 1e6, 1e6];
  const bsp = {
    header: { isFBSP: false },
    lumps: [],
    entities: [],
    textures: [{ name: "floor", contentFlags: ContentFlags.SOLID, surfaceFlags: 0 }],
    planes,
    nodes: [{ planeIndex: 0, children: [-1, -1], mins: bounds.map((v) => -v), maxs: bounds }],
    leafs: [
      {
        cluster: 0,
        area: 0,
        mins: bounds.map((v) => -v),
        maxs: bounds,
        firstLeafFace: 0,
        numLeafFaces: 0,
        firstLeafBrush: 0,
        numLeafBrushes: 1,
      },
    ],
    leafFaces: [],
    leafBrushes: [0],
    models: [],
    brushes: [{ firstSide: 0, numSides: 6, shaderIndex: 0 }],
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
  return new SharedCollisionWorld(new SweepBackendAdapter(backend));
}

describe("DroppedWeaponSystem lifetime (QA-WO12 regression)", () => {
  it("keeps a dropped weapon alive past the tick it spawned (despawnTicks must be > 0)", () => {
    const sys = new DroppedWeaponSystem();
    const { state, entities } = makeStubState();

    sys.queueDrop({
      weaponId: "rlauncher",
      ammo: 10,
      position: { x: 0, y: 100, z: 0 },
      velocity: { x: 10, y: 180, z: 0 },
    });

    // Spawn tick — the bug removed the entity in the same update() call.
    sys.update(state, 1 / 125, 1000 as never);
    expect(entities.size).toBe(1);

    const dropped = [...entities.values()][0];
    // dt = 1/0 = Infinity would have driven the position to NaN/Infinity.
    expect(Number.isFinite(dropped.transform?.position.y ?? Number.NaN)).toBe(true);
  });

  it("survives ~100 ticks (15s despawn window at the base rate, not 0)", () => {
    const sys = new DroppedWeaponSystem();
    const { state, entities } = makeStubState();

    sys.queueDrop({ weaponId: "plasmagun", ammo: 50, position: { x: 0, y: 64, z: 0 } });
    for (let tick = 1000; tick < 1100; tick++) sys.update(state, 1 / 125, tick as never);

    expect(entities.size).toBe(1);
  });

  it("removes spawned and queued warmup drops on match reset", () => {
    const sys = new DroppedWeaponSystem();
    const { state, entities } = makeStubState();

    sys.queueDrop({ weaponId: "rlauncher", ammo: 10, position: { x: 0, y: 64, z: 0 } });
    sys.update(state, 1 / 125, 1000 as never);
    expect(entities.size).toBe(1);

    sys.queueDrop({ weaponId: "riotgun", ammo: 8, position: { x: 10, y: 64, z: 0 } });
    sys.resetForMatch(state);
    sys.update(state, 1 / 125, 1001 as never);

    expect(entities.size).toBe(0);
    expect(sys.getPendingDropEvents()).toHaveLength(0);
  });
});

describe("DroppedWeaponSystem physics", () => {
  it("brings a drop to rest exactly where the shared item throw lands it", async () => {
    const collision = await floor();
    const sys = new DroppedWeaponSystem();
    sys.setCollisionWorld(collision);
    const { state, entities } = makeStubState();
    const start = { x: 0, y: 64, z: 0 };
    const velocity = { x: 60, y: 150, z: 20 };

    sys.queueDrop({ weaponId: "rlauncher", ammo: 10, position: { ...start }, velocity: { ...velocity } });
    for (let tick = 1000; tick < 1625; tick++) sys.update(state, 1 / 125, tick as never);

    const rest = landThrownItem(start, velocity, collision);
    expect(rest).not.toBeNull();
    // Resting on the floor (top y = 0), within its 8u box.
    expect(rest?.y).toBeGreaterThan(0);
    expect(rest?.y).toBeLessThan(8);
    expect(entities.size).toBe(1);
    expect([...entities.values()][0].transform?.position).toEqual(rest);
  });
});
