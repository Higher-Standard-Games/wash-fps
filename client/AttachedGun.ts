import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { PlayerModelInstance } from "../../../engine/animation/PlayerModelManager";
import type { ModelLoadResult } from "../../../engine/loader/model/ModelLoader";
import { bindLoaderLeftovers } from "../../../engine/loader/model/ModelSourceCache";

/** Keep the imported mesh, joint, attachment and handedness transforms together. */
export function createGunGrip(result: ModelLoadResult): TransformNode {
  const grip = new TransformNode("gun_hand_attachment", result.root.getScene());
  // The holder applies visual scale; the loader's outer catalog scale is redundant.
  result.root.scaling.setAll(1);
  result.root.parent = grip;
  result.root.setEnabled(true);
  bindLoaderLeftovers(grip, null, result.animationGroups);
  return grip;
}

/** The packaged gun's +X barrel follows the right hand's +Y finger direction. */
export function holdGunGrip(
  grip: TransformNode,
  player: PlayerModelInstance,
  visualScale: number,
  playerScale: number,
): void {
  const hand = player.skeleton?.bones.find((bone) => bone.name === "mixamorig:RightHand");
  grip.parent = null;
  if (hand) {
    if (player.weaponHand) grip.parent = player.weaponHand;
    else grip.attachToBone(hand, player.mesh);
    grip.position.setAll(0);
    grip.scaling.setAll((visualScale / (player.modelScale ?? playerScale)) * 0.5);
    // The imported left-handed root reflects X; keep +Y on the hand's thumb side.
    grip.rotation.set(player.mesh.getScene().useRightHandedSystem ? Math.PI : 0, 0, -Math.PI / 2);
  } else {
    grip.parent = player.anchor;
    grip.position.set(0, 30, 0);
    grip.scaling.setAll(visualScale);
    grip.rotation.setAll(0);
  }
  grip.setEnabled(true);
  player.attachedWeapon = grip;
}
