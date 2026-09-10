import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SplashDropletRenderer } from "../client/SplashDropletRenderer";
import { MAX_DROPLETS } from "../client/SplashDroplets";

let engine: NullEngine;
let scene: Scene;
let renderer: SplashDropletRenderer;
beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  renderer = new SplashDropletRenderer(scene);
});
afterEach(() => {
  renderer.dispose();
  scene.dispose();
  engine.dispose();
});

it("uses two soft-shader triangles per droplet, excluding captures and the weapon camera", () => {
  expect(renderer.start()).toBe(true);
  const mesh = scene.meshes[0];
  expect(mesh.getTotalVertices()).toBe(MAX_DROPLETS * 4);
  expect(mesh.getTotalIndices()).toBe(MAX_DROPLETS * 6);
  expect(mesh.material).toBeInstanceOf(ShaderMaterial);
  expect(mesh.material!.disableDepthWrite).toBe(true);
  expect(mesh.metadata).toMatchObject({ effectOwned: true, excludeFromWaterCapture: true });
  expect(mesh.layerMask & 0x10000000).toBe(0);
  expect(scene.customRenderTargets).toHaveLength(0);
  expect(scene.postProcesses).toHaveLength(0);
});

it("packs velocity/fade per live quad and sorts at the splash instead of world origin", () => {
  renderer.start();
  renderer.update(
    new Float32Array([704, 72, -960, 706, 74, -958]),
    new Float32Array([0.5, 0.8]),
    2,
    new Float32Array([10, 100, 20, 15, -80, 30]),
    new Float32Array([1, 0.2]),
  );
  const mesh = scene.meshes[0];
  expect(renderer.drawnCount).toBe(2);
  expect(mesh.subMeshes[0].indexCount).toBe(12);
  expect(Array.from(mesh.getVerticesData("sprayVelocity")!.slice(0, 3))).toEqual([10, 100, 20]);
  expect(mesh.getVerticesData("sprayData")![9]).toBeCloseTo(0.2);
  expect(mesh.getBoundingInfo().boundingBox.center.x).toBe(705);
  expect(mesh.subMeshes[0].getBoundingInfo().boundingSphere).toBeDefined();
  expect(mesh.isEnabled()).toBe(true);
  renderer.update(new Float32Array(0), new Float32Array(0), 0);
  expect(mesh.isEnabled()).toBe(false);
  expect(renderer.drawnCount).toBe(0);
});

it("reuses buffers, bounds the visible count and disposes its material", () => {
  renderer.start();
  renderer.start();
  expect(scene.meshes).toHaveLength(1);
  renderer.update(new Float32Array([1, 2, 3]), new Float32Array([1]), 10000);
  expect(renderer.drawnCount).toBe(1);
  renderer.dispose();
  renderer.dispose();
  expect(scene.meshes).toHaveLength(0);
  expect(scene.materials.some((m) => m.name === "liquid-splash-spray-mat")).toBe(false);
});
