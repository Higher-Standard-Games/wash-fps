import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LiquidSurfaceSystem } from "../../../../../engine/rendering/water/LiquidSurfaceSystem";
import { waterDisturbancesFor } from "../../../../../engine/rendering/water/WaterDisturbances";
import WaterCommand from "../WaterCommand";

const context = vi.hoisted(() => ({ camera: null as FreeCamera | null }));
vi.mock("../../../../../engine/camera/CameraSystem", () => ({
  CameraSystem: { getInstance: () => ({ getCamera: () => context.camera }) },
}));
vi.mock("../../../Game", () => ({
  Game: { getInstance: () => ({ getLocalPlayerPosition: () => ({ x: 0, y: 16, z: 0 }), debugSplash: () => {} }) },
}));
vi.mock("../../../../../engine/physics/CollisionManager", () => ({
  getCollisionManager: () => ({ isInitialized: () => false }),
}));

let engine: NullEngine;
let scene: Scene;
let renderer: LiquidSurfaceSystem;
const command = new WaterCommand();
beforeEach(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  context.camera = new FreeCamera("world", new Vector3(0, 50, -50), scene);
  context.camera.setTarget(Vector3.Zero());
  const pool = CreateGround("water", { width: 200, height: 200 }, scene);
  pool.metadata = { liquidKind: "water" };
  renderer = new LiquidSurfaceSystem(scene);
  renderer.claim(pool);
});
afterEach(() => {
  renderer.dispose();
  scene.dispose();
  engine.dispose();
  context.camera = null;
});

it("injects a shader-only ripple at the aimed replacement surface", async () => {
  expect(await command.execute(["ripple"])).toContain("Shader-only ripple");
  expect(waterDisturbancesFor(scene).impulses[0]).toMatchObject({ y: 0, radius: 96 });
  expect(scene.meshes).toHaveLength(1);
});

it("does not aim through solid geometry into a pool", async () => {
  const bank = CreateBox("bank", { size: 24 }, scene);
  bank.position.set(0, 25, -25);
  bank.computeWorldMatrix(true);
  expect(await command.execute(["ripple"])).toContain("No ripple emitted");
  expect(waterDisturbancesFor(scene).impulses).toHaveLength(0);
});

it("keeps delivery diagnostics after the wave expires", async () => {
  await command.execute(["ripple"]);
  waterDisturbancesFor(scene).update(2);
  const status = await command.execute(["render"]);
  expect(status).toContain("1/1 replacement");
  expect(status).toContain("0 active; 1 accepted; 0 rejected");
});

it("does not claim a gameplay splash succeeded when the game emitter did nothing", async () => {
  expect(await command.execute(["splash"])).toContain("No replacement-water ripple emitted");
});

it("reports rejected geometry without creating a disc fallback", async () => {
  waterDisturbancesFor(scene).resolveSurface = () => null;
  expect(await command.execute(["ripple"])).toContain("no supported water surface");
  expect(scene.meshes).toHaveLength(1);
});
