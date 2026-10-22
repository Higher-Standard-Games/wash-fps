import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it, vi } from "vitest";
import { BrushModelState } from "../../../../shared/bsp/BrushModelState";

const context = vi.hoisted(() => ({
  state: undefined as BrushModelState | undefined,
  loads: 0,
  scene: undefined as Scene | undefined,
}));
vi.mock("../../../../engine/physics/CollisionManager", () => ({
  getCollisionManager: () => ({
    getSweepBackend: () => ({ brushModels: context.state, trace: () => ({ fraction: 1 }) }),
  }),
}));
vi.mock("../../../../engine/loader/model/ModelLoader", () => ({
  ModelLoader: {
    getInstance: () => ({
      loadModel: async () => {
        context.loads++;
        const root = new TransformNode("template", context.scene);
        new Mesh("chunk", context.scene).parent = root;
        return { root, meshes: [], animationGroups: [], skeletons: [] };
      },
    }),
  },
}));

import { BombSiteDebris } from "../BombSiteDebris";

describe("site debris lifecycle", () => {
  it("emits only new destruction, bounds fragment count and cleans up next round", async () => {
    const engine = new NullEngine(),
      scene = new Scene(engine);
    context.scene = scene;
    context.state = new BrushModelState([
      {
        modelIndex: 5,
        initiallyEnabled: true,
        targetname: "a",
        delay: 0.6,
        origin: { x: 0, y: 0, z: 0 },
        min: { x: 0, y: 0, z: 0 },
        max: { x: 10, y: 10, z: 10 },
        debris: ["chunk.md3"],
      },
    ]);
    const debris = new BombSiteDebris(scene);
    const count = () => scene.transformNodes.filter((node) => node.name.startsWith("site_debris_")).length;
    try {
      debris.update(0, 1, [5]);
      await Promise.resolve();
      expect(count()).toBe(0); // Joining after detonation must not replay debris.
      debris.update(0, 2, []);
      debris.update(0, 2, [5]);
      expect(count()).toBe(12);
      debris.update(0, 2, [5]);
      expect(count()).toBe(12); // Repeated persistent state is not another explosion.
      debris.update(0, 3, []);
      expect(count()).toBe(0);
      debris.update(0, 3, [5]);
      for (let i = 0; i < 90; i++) debris.update(0.05, 3, [5]);
      expect(count()).toBe(0);
    } finally {
      debris.dispose();
      scene.dispose();
      engine.dispose();
      context.scene = undefined;
      context.state = undefined;
    }
  });

  it("preloads a map's debris once, not every frame", () => {
    const engine = new NullEngine(),
      scene = new Scene(engine);
    context.scene = scene;
    context.loads = 0;
    context.state = new BrushModelState([
      {
        modelIndex: 5,
        initiallyEnabled: true,
        targetname: "a",
        delay: 0.6,
        origin: { x: 0, y: 0, z: 0 },
        min: { x: 0, y: 0, z: 0 },
        max: { x: 10, y: 10, z: 10 },
        debris: ["chunk.md3", "plank.md3"],
      },
    ]);
    const debris = new BombSiteDebris(scene);
    try {
      for (let i = 0; i < 30; i++) debris.update(0.016, 1, []);
      expect(context.loads).toBe(2);
    } finally {
      debris.dispose();
      scene.dispose();
      engine.dispose();
      context.scene = undefined;
      context.state = undefined;
    }
  });
});
