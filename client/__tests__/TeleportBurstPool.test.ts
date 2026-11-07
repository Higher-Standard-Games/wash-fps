import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it, vi } from "vitest";
import { TeleportEffect } from "../TeleportEffect";

/**
 * A teleport's starburst comes from a pool: when it ends it is disabled, and
 * the next teleport plays the same meshes and material. Creating and disposing
 * them per teleport changed the scene's draw list every time.
 */
describe("teleport burst pool", () => {
  it("ages unrecorded movie lead-ins and clears effects without rebuilding the pool", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const fx = TeleportEffect.getInstance();
    const internal = fx as unknown as {
      ensureScene(scene: Scene): void;
      spawnBurst(position: { x: number; y: number; z: number }): void;
      update(): void;
    };
    let time = -2000;
    try {
      internal.ensureScene(scene);
      fx.setPresentationClock(() => time);
      internal.spawnBurst({ x: 0, y: 0, z: 0 });
      const meshes = scene.meshes.filter((mesh) => mesh.name.startsWith("tp_burst"));
      expect(meshes.some((mesh) => mesh.isEnabled())).toBe(true);
      time = 0;
      internal.update();
      expect(meshes.every((mesh) => !mesh.isEnabled())).toBe(true);
      internal.spawnBurst({ x: 0, y: 0, z: 0 });
      fx.clear();
      expect(meshes.every((mesh) => !mesh.isEnabled())).toBe(true);
      expect(meshes.every((mesh) => !mesh.isDisposed())).toBe(true);
    } finally {
      fx.dispose();
      scene.dispose();
      engine.dispose();
    }
  });
  it("plays the same burst meshes again and disposes them with the effect", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const now = vi.spyOn(performance, "now");
    const fx = TeleportEffect.getInstance() as unknown as {
      ensureScene(scene: Scene): void;
      spawnBurst(pos: { x: number; y: number; z: number }): void;
      update(): void;
      dispose(): void;
    };
    try {
      let t = 1000;
      now.mockReturnValue(t);
      fx.ensureScene(scene);
      const burstMeshes = () => scene.meshes.filter((mesh) => mesh.name.startsWith("tp_burst"));
      const shown = () => burstMeshes().filter((mesh) => mesh.isEnabled()).length;
      const runOut = () => {
        for (let i = 0; i < 10; i++) {
          t += 100;
          now.mockReturnValue(t);
          fx.update();
        }
      };

      fx.spawnBurst({ x: 0, y: 0, z: 0 });
      const meshes = burstMeshes();
      expect(meshes).toHaveLength(2);
      expect(shown()).toBe(2);
      runOut();
      expect(shown()).toBe(0);

      const materials = scene.materials.length;
      fx.spawnBurst({ x: 64, y: 0, z: 0 });
      expect(burstMeshes()).toEqual(meshes);
      expect(scene.materials.length).toBe(materials);
      expect(shown()).toBe(2);
      expect(meshes[0].position.x).toBe(64);

      fx.dispose();
      expect(burstMeshes()).toHaveLength(0);
    } finally {
      now.mockRestore();
      scene.dispose();
      engine.dispose();
    }
  });
});
