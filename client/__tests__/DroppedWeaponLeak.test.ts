import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLASMAGUN } from "../../../../shared/entities/definitions/weapons/plasmagun";
import { EntityRegistry } from "../../../../shared/entities/EntityRegistry";
import type { DroppedWeaponInfo } from "../DroppedWeaponRenderer";

/**
 * Dropped weapons leave nothing behind once they are gone (NullEngine).
 *
 * Each one loads a model and keeps only its meshes. The loader's root, glTF's
 * `__root__`, the nodes between and the animation groups stayed in the scene
 * after the weapon was picked up or expired, one set per drop (W4).
 */
const scene = vi.hoisted(() => ({
  current: null as unknown as import("@babylonjs/core/scene").Scene,
  mainLoads: 0,
  barrelLoads: 0,
  pauseBarrel: false,
  releaseBarrel: () => {},
}));

vi.mock("../../../../engine/loader/bsp/BspManager", () => ({
  BspManager: { getInstance: () => ({ getPvsCuller: () => null }) },
}));
vi.mock("../../../../engine/loader/AssetPreloader", () => ({
  AssetPreloader: { getInstance: () => ({ hasModel: () => false }) },
}));
vi.mock("../../../../engine/physics/PhysicsSystem", () => ({
  PhysicsSystem: { getInstance: () => ({ isInitialized: () => false, removeBody: () => {} }) },
}));
vi.mock("../../../../engine/loader/model/ModelLoader", () => ({
  ModelLoader: {
    getInstance: () => ({
      isInitialized: () => true,
      loadModel: async () => {
        scene.mainLoads++;
        const root = new TransformNode("__root__", scene.current);
        const between = new TransformNode("RootNode", scene.current);
        between.parent = root;
        const gun = MeshBuilder.CreateBox("gun", { size: 1 }, scene.current);
        gun.material = new StandardMaterial("gun_mat", scene.current);
        gun.parent = between;
        return { root, meshes: [gun], animationGroups: [new AnimationGroup("idle", scene.current)], skeletons: [] };
      },
    }),
  },
}));
vi.mock("@babylonjs/core/Loading/sceneLoader", () => ({
  ImportMeshAsync: async () => {
    scene.barrelLoads++;
    const root = new Mesh("__root__", scene.current);
    root.scaling.x = -1;
    const authored = new TransformNode("barrelAuthored", scene.current);
    authored.parent = root;
    authored.position.x = 7;
    const mesh = MeshBuilder.CreateBox("barrel", {}, scene.current);
    mesh.material = new StandardMaterial("barrel_mat", scene.current);
    mesh.parent = authored;
    if (scene.pauseBarrel)
      await new Promise<void>((resolve) => {
        scene.releaseBarrel = resolve;
      });
    return {
      meshes: [root, mesh],
      transformNodes: [authored],
      skeletons: [],
      animationGroups: [new AnimationGroup("barrelClip", scene.current)],
    };
  },
}));
vi.mock("../../../../engine/loader/model/TagsLoader", () => ({
  loadTags: async () => [],
  findTag: () => ({ boneName: "", offset: new Vector3(1, 2, 3), rotation: new Vector3(0.1, 0.2, 0.3) }),
}));
vi.mock("../../world/PickupPrompt", () => ({ hidePickupPrompt: vi.fn(), showPickupPrompt: vi.fn() }));

const { DroppedWeaponRenderer } = await import("../DroppedWeaponRenderer");

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("dropped weapons coming and going", () => {
  beforeEach(() => {
    scene.mainLoads = 0;
    scene.barrelLoads = 0;
    scene.pauseBarrel = false;
  });
  afterEach(() => {
    scene.current.getEngine().dispose();
    vi.restoreAllMocks();
  });

  it("leave the scene's nodes, meshes, materials and animation groups where they were", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    scene.current = new Scene(new NullEngine());
    const renderer = new DroppedWeaponRenderer(scene.current, true);
    const counts = () => {
      const s = scene.current;
      return [s.transformNodes.length, s.meshes.length, s.materials.length, s.animationGroups.length];
    };
    const before = counts();
    let cachedCounts: number[] | undefined;

    for (let drop = 0; drop < 10; drop++) {
      const entities = new Map<string, DroppedWeaponInfo>([
        [`item_${drop}`, { x: 0, y: 0, z: 0, weaponId: "rlauncher" }],
      ]);
      renderer.syncServerEntities(entities);
      await settle();
      expect(scene.current.meshes.some((mesh) => mesh.name === `droppedWeapon_item_${drop}`)).toBe(true);
      renderer.syncServerEntities(new Map());
      cachedCounts ??= counts();
      expect(counts()).toEqual(cachedCounts);
    }
    await settle();
    expect(scene.mainLoads).toBe(1);
    renderer.dispose();
    expect(counts()).toEqual(before);
  });

  it("deduplicates concurrent main/barrel sources while preserving independent barrel transforms", async () => {
    vi.spyOn(EntityRegistry.getInstance(), "get").mockReturnValue(PLASMAGUN);
    scene.current = new Scene(new NullEngine());
    const renderer = new DroppedWeaponRenderer(scene.current, true);
    const before = [
      scene.current.meshes.length,
      scene.current.transformNodes.length,
      scene.current.materials.length,
      scene.current.animationGroups.length,
    ];
    const entities = new Map<string, DroppedWeaponInfo>([
      ["item_a", { x: 10, y: 20, z: 30, weaponId: "plasmagun" }],
      ["item_b", { x: 50, y: 60, z: 70, weaponId: "plasmagun" }],
    ]);
    renderer.syncServerEntities(entities);
    await vi.waitFor(() =>
      expect(scene.current.meshes.filter((m) => m.name === "barrel" && m.isEnabled())).toHaveLength(4),
    );
    expect(scene.mainLoads).toBe(1);
    expect(scene.barrelLoads).toBe(1);
    const gun = scene.current.getMeshByName("droppedWeapon_item_a")!;
    expect(gun.position.asArray()).toEqual([10, 20, 30]);
    const barrels = gun.getChildMeshes(false).filter((m) => m.name === "__root__");
    expect(barrels).toHaveLength(2);
    expect(barrels.map((m) => m.position.asArray())).toEqual([
      [1, 2, -1],
      [1, 2, 3],
    ]);
    expect(barrels[0].rotation.asArray()).toEqual([0.1, 0.2, 0.3]);
    expect(barrels[0].scaling.x).toBe(-1);
    const meshes = barrels.map((m) => m.getChildMeshes(false)[0] as Mesh);
    expect((meshes[0].parent as TransformNode).position.x).toBe(7);
    expect(meshes[0].geometry).toBe(meshes[1].geometry);
    expect(meshes[0].material).not.toBe(meshes[1].material);
    renderer.syncServerEntities(new Map([["item_b", entities.get("item_b")!]]));
    expect(scene.current.meshes.filter((m) => m.name === "barrel" && m.isEnabled())).toHaveLength(2);
    expect(renderer.count).toBe(1);
    renderer.dispose();
    expect([
      scene.current.meshes.length,
      scene.current.transformNodes.length,
      scene.current.materials.length,
      scene.current.animationGroups.length,
    ]).toEqual(before);
  });

  it("releases main leftovers and late barrel imports when disposed during barrel loading", async () => {
    vi.spyOn(EntityRegistry.getInstance(), "get").mockReturnValue(PLASMAGUN);
    scene.current = new Scene(new NullEngine());
    scene.pauseBarrel = true;
    const renderer = new DroppedWeaponRenderer(scene.current, true);
    renderer.syncServerEntities(new Map([["item_a", { x: 0, y: 0, z: 0, weaponId: "plasmagun" }]]));
    await vi.waitFor(() => expect(scene.barrelLoads).toBe(1));
    renderer.dispose();
    scene.releaseBarrel();
    await vi.waitFor(() => expect(scene.current.meshes).toHaveLength(0));
    expect(scene.current.transformNodes).toHaveLength(0);
    expect(scene.current.animationGroups).toHaveLength(0);
    expect(scene.current.materials).toHaveLength(0);
    expect(scene.barrelLoads).toBe(1);
  });
});
