import { Bone } from "@babylonjs/core/Bones/bone";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Space } from "@babylonjs/core/Maths/math.axis";
import { Matrix, Quaternion } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { expect, it } from "vitest";
import type { PlayerModelInstance } from "../../../../../engine/animation/PlayerModelManager";
import { createRagdollFrame } from "../RagdollFrame";

it.each([0.01, 1])("preserves bone scale across world-rotation updates with export scale %s", (exportScale) => {
  const engine = new NullEngine(),
    scene = new Scene(engine);
  try {
    const anchor = new TransformNode("anchor", scene);
    anchor.position.set(120, 30, -70);
    anchor.rotation.y = 1.2;
    const root = new Mesh("root", scene);
    root.parent = anchor;
    root.scaling.setAll(36);
    const armature = new TransformNode("armature", scene);
    armature.parent = root;
    armature.scaling.setAll(exportScale);
    const mesh = new Mesh("skin", scene);
    mesh.parent = armature;
    const skeleton = new Skeleton("rig", "rig", scene);
    const bone = new Bone("hips", skeleton, null, Matrix.Translation(0, 1, 0));
    const model = { id: "test", anchor, mesh: root, rigMesh: mesh } as PlayerModelInstance;
    const frame = createRagdollFrame(model);
    expect(frame.getWorldMatrix().equalsWithEpsilon(mesh.computeWorldMatrix(true), 0.00001)).toBe(true);
    expect(frame.scaling.x).toBeCloseTo(36 * exportScale);
    expect(frame.absoluteScaling.x).toBeCloseTo(frame.scaling.x);
    bone.setRotationQuaternion(Quaternion.Identity(), Space.WORLD, frame);
    for (const value of bone.getScale().asArray()) expect(value).toBeCloseTo(1, 5);
    frame.dispose();
    skeleton.dispose();
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
