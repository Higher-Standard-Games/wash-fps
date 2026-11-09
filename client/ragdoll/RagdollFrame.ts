import { Quaternion } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { PlayerModelInstance } from "../../../../engine/animation/PlayerModelManager";

/** Give bone world-rotation setters matching local and world export scale. */
export function createRagdollFrame(model: PlayerModelInstance): TransformNode {
  const mesh = model.rigMesh ?? model.mesh;
  const frame = new TransformNode(`ragdoll_frame_${model.id}`, mesh.getScene());
  frame.rotationQuaternion = Quaternion.Identity();
  mesh.computeWorldMatrix(true).decompose(frame.scaling, frame.rotationQuaternion, frame.position);
  // Actor anchors contain translation and yaw, with no scale.
  frame.setParent(model.anchor);
  frame.computeWorldMatrix(true);
  return frame;
}
