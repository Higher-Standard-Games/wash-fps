import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DroppedWeaponInfo } from "../DroppedWeaponRenderer";

/**
 * Dropped weapons leave nothing behind once they are gone (NullEngine).
 *
 * Each one loads a model and keeps only its meshes. The loader's root, glTF's
 * `__root__`, the nodes between and the animation groups stayed in the scene
 * after the weapon was picked up or expired, one set per drop (W4).
 */
const scene = vi.hoisted(() => ({ current: null as unknown as import("@babylonjs/core/scene").Scene }));

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
vi.mock("../../world/PickupPrompt", () => ({ hidePickupPrompt: vi.fn(), showPickupPrompt: vi.fn() }));

const { DroppedWeaponRenderer } = await import("../DroppedWeaponRenderer");

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("dropped weapons coming and going", () => {
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

    for (let drop = 0; drop < 10; drop++) {
      const entities = new Map<string, DroppedWeaponInfo>([
        [`item_${drop}`, { x: 0, y: 0, z: 0, weaponId: "rlauncher" }],
      ]);
      renderer.syncServerEntities(entities);
      await settle();
      expect(scene.current.meshes.some((mesh) => mesh.name === `droppedWeapon_item_${drop}`)).toBe(true);
      renderer.syncServerEntities(new Map());
    }
    await settle();
    expect(counts()).toEqual(before);
    renderer.dispose();
  });
});
