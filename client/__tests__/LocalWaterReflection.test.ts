import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, expect, it, vi } from "vitest";
import { RemotePlayerRenderer } from "../RemotePlayerRenderer";

vi.mock("../../../../engine/weapon/HitscanEffects", () => ({
  getHitscanEffects: () => ({ clearRemoteLightningMuzzleResolver() {} }),
}));
const engine = new NullEngine();
const scene = new Scene(engine);
afterEach(() => {
  vi.restoreAllMocks();
});

it("owns a hidden local model, updates its pose, suspends and disposes it", () => {
  // Test the presentation method without starting network/render services.
  const renderer = Object.create(RemotePlayerRenderer.prototype) as RemotePlayerRenderer;
  const anchor = new Mesh("local-root", scene);
  const mesh = CreateBox("body", {}, scene);
  mesh.parent = anchor;
  const model = { anchor, mesh, currentAnim: "idle", masterGroup: { pause: vi.fn(), play: vi.fn() } };
  const manager = {
    isLoaded: true,
    resetRootMotion: vi.fn(),
    playAnimation: vi.fn(),
    disposeInstance: vi.fn(),
    dispose: vi.fn(),
  };
  Object.assign(renderer, {
    modelManager: manager,
    localReflectionModel: null,
    disposed: false,
    hitboxes: new Map(),
    deadEntities: new Map(),
    teams: new Map(),
    ffaColors: { clear: vi.fn() },
    createModelInstance: () => model,
  });
  const state = {
    x: 20,
    y: 80,
    z: 30,
    yaw: 0.7,
    vx: 0,
    vy: 0,
    vz: 0,
    grounded: true,
    crouching: false,
    sliding: false,
    wallJumping: false,
  };
  renderer.syncLocalWaterReflection(state);
  expect(mesh.isVisible).toBe(false);
  expect(mesh.isPickable).toBe(false);
  expect(anchor.metadata.waterReflectionOnly).toBe(true);
  expect(anchor.position.asArray()).toEqual([20, 56, 30]);
  expect(anchor.rotation.y).toBe(0.7);
  renderer.syncLocalWaterReflection(null);
  expect(anchor.isEnabled()).toBe(false);
  expect(model.masterGroup.pause).toHaveBeenCalled();
  renderer.syncLocalWaterReflection({ ...state, x: 40, crouching: true });
  expect(anchor.isEnabled()).toBe(true);
  expect(anchor.position.asArray()).toEqual([40, 46, 30]);
  expect(mesh.isVisible).toBe(false);
  renderer.dispose();
  expect(manager.disposeInstance).toHaveBeenCalledWith(model);
  anchor.dispose();
  scene.dispose();
  engine.dispose();
});
