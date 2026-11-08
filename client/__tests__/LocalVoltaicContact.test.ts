import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { expect, it } from "vitest";
import { getHitscanEffects, type LocalLightningTargetResolver } from "../../../../engine/weapon/HitscanEffects";
import { RemotePlayerRenderer } from "../RemotePlayerRenderer";

it("predicts the nearest rendered player contact, respecting walls, movement, crouching and death", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const renderer = new RemotePlayerRenderer(scene);
  const effects = getHitscanEffects() as unknown as {
    localLightningTargetResolver: LocalLightningTargetResolver | null;
  };
  const resolve = effects.localLightningTargetResolver!;
  const state = renderer as unknown as { hitboxes: Map<string, unknown>; deadEntities: Map<string, number> };
  const near = MeshBuilder.CreateBox("near", { width: 32, height: 56, depth: 32 }, scene);
  const far = MeshBuilder.CreateBox("far", { width: 32, height: 56, depth: 32 }, scene);
  near.position.set(0, 28, 80);
  far.position.set(0, 28, 140);
  near.isPickable = false;
  near.setEnabled(false);
  const nearHitbox = { mesh: near, currentHeight: 56 };
  state.hitboxes.set("far", { mesh: far, currentHeight: 56 });
  state.hitboxes.set("near", nearHitbox);
  const eye = new Vector3(0, 40, 0);
  const result = new Vector3();
  const shoot = (range = 200) => resolve(eye, Vector3.Forward(), range, result);
  try {
    expect(shoot()).toBe(true);
    expect(result.z).toBe(64);
    expect(shoot(50)).toBe(false);
    near.position.x = 100;
    expect(shoot()).toBe(true);
    expect(result.z).toBe(124);
    near.position.x = 0;
    near.scaling.y = 20 / 56;
    nearHitbox.currentHeight = 20;
    near.position.y = 10;
    expect(shoot()).toBe(true);
    expect(result.z).toBe(124);
    state.deadEntities.set("far", 0);
    expect(shoot()).toBe(false);
    eye.y = 10;
    expect(shoot()).toBe(true);
    expect(result.z).toBe(64);
    expect(resolve(eye, Vector3.Backward(), 200, result)).toBe(false);
  } finally {
    renderer.dispose();
    expect(effects.localLightningTargetResolver).toBeNull();
    engine.dispose();
  }
});
