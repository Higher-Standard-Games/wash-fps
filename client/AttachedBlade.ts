import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { PlayerModelInstance } from "../../../engine/animation/PlayerModelManager";
import type { ModelLoadResult } from "../../../engine/loader/model/ModelLoader";
import { bindLoaderLeftovers } from "../../../engine/loader/model/ModelSourceCache";

/** Attach the normalized +X blade without discarding its GLB export transforms. */
export function attachBladeToPlayer(
  result: ModelLoadResult,
  player: PlayerModelInstance,
  visualScale: number,
  playerScale: number,
): TransformNode {
  const grip = new TransformNode("blade_hand_attachment", player.mesh.getScene());
  const hand = player.skeleton?.bones.find((bone) => bone.name === "mixamorig:RightHand");
  if (hand) {
    grip.attachToBone(hand, player.mesh);
    grip.scaling.setAll(visualScale / playerScale);
  } else {
    grip.parent = player.anchor;
    grip.position.set(0, 30, 0);
    grip.scaling.setAll(visualScale);
  }
  // glTF's left-handed conversion reverses export X; hand +Y follows the fingers.
  const modelXSign = player.mesh.getScene().useRightHandedSystem ? 1 : -1;
  grip.rotation.set(Math.PI, 0, (-modelXSign * Math.PI) / 2);
  const offset = new TransformNode("blade_grip_offset", player.mesh.getScene());
  offset.parent = grip;
  // The packaged export's handle centre is at X=-0.45 model units.
  offset.position.x = 0.45 * modelXSign;
  result.root.parent = offset;
  result.root.setEnabled(true);
  bindLoaderLeftovers(grip, null, result.animationGroups);
  player.attachedWeapon = grip;
  return grip;
}
