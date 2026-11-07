import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlideDust } from "../SlideDust";

describe("slide dust", () => {
  let engine: NullEngine, scene: Scene;
  const mesh = () => scene.getMeshByName("slide-dust") as Mesh;
  // Read the current upload data; Babylon's world-matrix getter caches snapshots.
  const matrix = () =>
    Matrix.FromArray(
      (mesh() as unknown as { _thinInstanceDataStorage: { matrixData: Float32Array } })._thinInstanceDataStorage
        .matrixData,
    );
  const emit = (x: number, active = true, id = "one", z = 0) =>
    SlideDust.emit(scene, id, { x, y: 4, z }, 400, 0, active);
  beforeEach(() => {
    engine = new NullEngine();
    scene = new Scene(engine);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    scene.dispose();
    engine.dispose();
    vi.restoreAllMocks();
  });

  it("creates no resources for walking and primes slides without a catch-up burst", () => {
    emit(0, false);
    expect(scene.meshes).toHaveLength(0);
    emit(0);
    expect(mesh().isEnabled()).toBe(false);
    emit(40);
    SlideDust.step(scene, 0.05);
    SlideDust.flush(scene);
    expect(mesh().thinInstanceCount).toBe(2);
    const matrices = mesh().thinInstanceGetWorldMatrices();
    expect(matrices[0].getTranslation().x).toBeLessThan(40);
    expect(matrices[0].getTranslation().y).toBeGreaterThan(0);
  });

  it("leaves a world trail that drops and fades after the player stops", () => {
    emit(0);
    emit(40);
    for (let i = 0; i < 4; i++) SlideDust.step(scene, 0.1);
    SlideDust.flush(scene);
    const start = matrix().getTranslation();
    emit(40, false);
    for (let i = 0; i < 3; i++) SlideDust.step(scene, 0.1);
    SlideDust.flush(scene);
    const falling = matrix().getTranslation();
    expect(falling.x).toBeLessThan(50);
    expect(falling.y).toBeLessThan(start.y);
    const colors = mesh().getVertexBuffer(VertexBuffer.ColorInstanceKind)?.getData() as Float32Array | null;
    expect(colors?.[3]).toBeGreaterThan(0);
    expect(colors?.[3]).toBeLessThan(0.6);
    for (let i = 0; i < 8; i++) SlideDust.step(scene, 0.1);
    SlideDust.flush(scene);
    expect(mesh().thinInstanceCount).toBe(1);
    expect(mesh().isEnabled()).toBe(false);
  });

  it("caps crowded trails at one mesh, one material and 128 instances", () => {
    for (let id = 0; id < 100; id++) {
      emit(0, true, String(id));
      emit(80, true, String(id));
    }
    SlideDust.step(scene, 0.05);
    SlideDust.flush(scene);
    expect(scene.meshes).toHaveLength(1);
    expect(scene.materials).toHaveLength(1);
    expect(mesh().getTotalVertices()).toBe(24);
    expect(mesh().thinInstanceCount).toBe(128);
    expect(mesh().isPickable).toBe(false);
  });

  it("starts close to the center, opens outward and stays airborne longer", () => {
    emit(0);
    emit(40);
    SlideDust.step(scene, 0.05);
    SlideDust.flush(scene);
    const initialWidth = Math.abs(matrix().getTranslation().z) * 2;
    expect(initialWidth).toBeLessThan(6);
    for (let i = 0; i < 4; i++) SlideDust.step(scene, 0.1);
    SlideDust.flush(scene);
    expect(Math.abs(matrix().getTranslation().z) * 2).toBeGreaterThan(initialWidth);
    for (let i = 0; i < 5; i++) SlideDust.step(scene, 0.1);
    SlideDust.flush(scene);
    expect(mesh().isEnabled()).toBe(true);
    expect(mesh().thinInstanceCount).toBe(2);
    SlideDust.step(scene, 0.1);
    SlideDust.step(scene, 0.1);
    SlideDust.flush(scene);
    expect(mesh().isEnabled()).toBe(false);
  });

  it("does not bridge a teleport and removes stale emitter travel", () => {
    emit(0);
    emit(1000);
    SlideDust.flush(scene);
    expect(mesh().thinInstanceCount).toBe(1);
    expect(mesh().isEnabled()).toBe(false);
    SlideDust.step(scene, 0.1);
    SlideDust.step(scene, 0.1);
    SlideDust.step(scene, 0.1);
    emit(1040);
    SlideDust.flush(scene);
    expect(mesh().thinInstanceCount).toBe(1);
    expect(mesh().isEnabled()).toBe(false);
  });

  it("keeps paused effects still and clears them without growing resources", () => {
    emit(0);
    emit(40);
    SlideDust.step(scene, 0.1);
    SlideDust.flush(scene);
    const initial = Array.from(matrix().toArray());
    SlideDust.step(scene, 0);
    SlideDust.flush(scene);
    expect(Array.from(matrix().toArray())).toEqual(initial);
    SlideDust.reset(scene);
    expect(mesh().thinInstanceCount).toBe(1);
    expect(mesh().isEnabled()).toBe(false);
    expect(scene.meshes).toHaveLength(1);
    expect(mesh().hasThinInstances).toBe(true);
    SlideDust.clear(scene);
    expect(scene.meshes).toHaveLength(0);
    expect(scene.materials).toHaveLength(0);
    emit(0);
    emit(40);
    SlideDust.flush(scene);
    expect(scene.meshes).toHaveLength(1);
  });

  it("cleans its observers when a map disposes the owned mesh", async () => {
    const before = scene.onNewEffectLayerAddedObservable.observers.length;
    const earlyGlow = new GlowLayer("early", scene);
    emit(0);
    const dust = mesh();
    const lateGlow = new GlowLayer("late", scene);
    // Scene layer-added notifications are also delivered on the next task.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(earlyGlow.hasMesh(dust)).toBe(false);
    expect(lateGlow.hasMesh(dust)).toBe(false);
    expect(scene.onNewEffectLayerAddedObservable.observers.length).toBe(before + 1);
    mesh().dispose();
    // Babylon defers removal from its observer array until the next task.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scene.onNewEffectLayerAddedObservable.observers.length).toBe(before);
    expect(scene.materials).toHaveLength(0);
    expect(earlyGlow.hasMesh(dust)).toBe(true);
    expect(lateGlow.hasMesh(dust)).toBe(true);
  });
});
