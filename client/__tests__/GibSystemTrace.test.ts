import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it, vi } from "vitest";

const collision = vi.hoisted(() => ({
  initialized: true,
  trace: vi.fn(),
}));

vi.mock("../../../../engine/physics/CollisionManager", () => ({
  getCollisionManager: () => ({ isInitialized: () => collision.initialized, trace: collision.trace }),
}));

const { GibSystem } = await import("../GibSystem");

interface GibState {
  active: boolean;
  traced: boolean;
  bounced: boolean;
  velY: number;
  posY: number;
  age: number;
}

function setup() {
  const scene = new Scene(new NullEngine());
  const gibs = GibSystem.create(scene);
  const pick = vi.spyOn(scene, "pickWithRay");
  gibs.spawn(0, 0, 0, 0, 0, 0);
  const all = (gibs as unknown as { gibs: GibState[] }).gibs;
  return { scene, gibs, pick, hero: all.find((g) => g.traced)! };
}

describe("GibSystem hero bounces", () => {
  afterEach(() => {
    collision.initialized = true;
    collision.trace.mockReset();
  });

  it("bounce off the BSP trace's surface and never pick scene triangles when collision is loaded", () => {
    const { gibs, pick, hero, scene } = setup();
    hero.age = 1; // past the spawn grace period
    hero.velY = -400;
    collision.trace.mockReturnValue({
      fraction: 0.5,
      endPos: new Vector3(0, -50, 0),
      normal: new Vector3(0, 1, 0),
      startSolid: false,
      allSolid: false,
      contents: 1,
    });
    gibs.update(1 / 60);
    expect(collision.trace).toHaveBeenCalled();
    expect(pick).not.toHaveBeenCalled();
    expect(hero.bounced).toBe(true);
    expect(hero.velY).toBeGreaterThan(0);
    expect(hero.posY).toBeCloseTo(-50 + 6 * 0.3, 5);
    scene.getEngine().dispose();
  });

  it("keep flying while the trace finds nothing", () => {
    const { gibs, hero, scene } = setup();
    hero.age = 1;
    collision.trace.mockReturnValue({
      fraction: 1,
      endPos: Vector3.Zero(),
      startSolid: false,
      allSolid: false,
      contents: 0,
    });
    gibs.update(1 / 60);
    expect(hero.bounced).toBe(false);
    scene.getEngine().dispose();
  });

  it("fall back to scene picking without map collision", () => {
    collision.initialized = false;
    const { gibs, pick, hero, scene } = setup();
    hero.age = 1;
    gibs.update(1 / 60);
    expect(collision.trace).not.toHaveBeenCalled();
    expect(pick).toHaveBeenCalled();
    scene.getEngine().dispose();
  });

  it("reuses pooled gibs immediately and removes idle candidates after clear and expiry", () => {
    const { gibs, scene } = setup();
    new FreeCamera("eye", Vector3.Zero(), scene);
    const candidates = () => {
      const source = scene.getActiveMeshCandidates();
      return source.data.slice(0, source.length);
    };
    const shards = () => candidates().filter((mesh) => /^gib_\d+$/.test(mesh.name));
    expect(shards()).toHaveLength(28);
    const count = scene.meshes.length;
    gibs.clear();
    expect(shards()).toHaveLength(0);
    gibs.spawn(0, 0, 0, 0, 0, 0);
    expect(scene.meshes).toHaveLength(count);
    expect(shards()).toHaveLength(28);
    gibs.update(9);
    expect(shards()).toHaveLength(0);
    const foreign = CreateBox("unmanaged", {}, scene);
    foreign.setEnabled(false);
    expect(candidates()).toContain(foreign);
    gibs.dispose();
    expect(candidates()).toEqual([foreign]);
    scene.getEngine().dispose();
  });
});
