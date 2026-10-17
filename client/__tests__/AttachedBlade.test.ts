import { Bone } from "@babylonjs/core/Bones/bone";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { expect, it } from "vitest";
import type { PlayerModelInstance } from "../../../../engine/animation/PlayerModelManager";
import { disposeModelResources } from "../../../../engine/loader/model/ModelSourceCache";
import { attachBladeToPlayer } from "../AttachedBlade";

it("keeps nested export normalization and points a 60-unit blade along the hand", () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const anchor = new TransformNode("player", scene);
    const body = MeshBuilder.CreateBox("body", {}, scene);
    body.parent = anchor;
    body.scaling.setAll(36);
    const skeleton = new Skeleton("player", "player", scene);
    const hand = new Bone("mixamorig:RightHand", skeleton, null, Matrix.Identity());
    const player = { anchor, mesh: body, skeleton, attachedWeapon: null } as unknown as PlayerModelInstance;
    const root = new TransformNode("loader", scene);
    const gltfRoot = new TransformNode("gltf", scene);
    gltfRoot.parent = root;
    gltfRoot.rotation.y = Math.PI;
    gltfRoot.scaling.z = -1;
    const normalization = new TransformNode("export", scene);
    normalization.parent = gltfRoot;
    normalization.scaling.setAll(0.1313852484276723);
    normalization.rotation.y = Math.PI / 2;
    const blade = MeshBuilder.CreateBox("blade", { width: 0.5, height: 0.5, depth: 15.242 }, scene);
    blade.parent = normalization;
    const grip = attachBladeToPlayer({ root, meshes: [blade], skeletons: [], animationGroups: [] }, player, 30, 36);
    expect(grip.parent).toBe(hand);
    expect(blade.parent).toBe(normalization);
    expect(normalization.parent).toBe(gltfRoot);
    const bounds = grip.getHierarchyBoundingVectors(true);
    const size = bounds.max.subtract(bounds.min);
    expect(size.y).toBeCloseTo(60.0776, 1);
    expect(size.x).toBeLessThan(3);
    expect(size.z).toBeLessThan(3);
    const forward = Vector3.TransformNormal(Vector3.Left(), grip.computeWorldMatrix(true)).normalize();
    expect(forward.y).toBeCloseTo(1);
    expect(player.attachedWeapon).toBe(grip);
    disposeModelResources([grip]);
    expect(root.isDisposed()).toBe(true);
    expect(blade.isDisposed()).toBe(true);
  } finally {
    engine.dispose();
  }
});
