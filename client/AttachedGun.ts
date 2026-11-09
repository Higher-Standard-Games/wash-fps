import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { GunSupport } from "../../../engine/animation/PlayerModelFit";
import type { PlayerModelInstance } from "../../../engine/animation/PlayerModelManager";
import type { ModelLoadResult } from "../../../engine/loader/model/ModelLoader";
import { bindLoaderLeftovers } from "../../../engine/loader/model/ModelSourceCache";

/** An assembled gun in its held frame before the grip's scale: barrel along +Y, top toward +X. */
export interface GunShape {
  /** The muzzle tag, on the bore line; null when the model has none. */
  muzzle: Vector3 | null;
  /** How far the gun reaches behind the grip along the barrel (zero or less). */
  back: number;
}

const gunShapes = new WeakMap<TransformNode, GunShape>();

/**
 * How far below its bore line, in gun model units, a gun rests on the
 * supporting palm: the barrel's underside on the packaged guns. Resting the
 * bore rather than the lowest point keeps a magazine or grip that hangs below
 * the barrel from tipping the gun.
 */
const BORE_ABOVE_PALM = 4.3;

/** The imported left-handed root reflects X; this keeps +Y on the hand's thumb side. */
function handedTurn(scene: Scene): Quaternion {
  return Quaternion.FromEulerAngles(scene.useRightHandedSystem ? Math.PI : 0, 0, -Math.PI / 2);
}

/** Keep the imported mesh, joint, attachment and handedness transforms together. */
export function createGunGrip(result: ModelLoadResult): TransformNode {
  const scene = result.root.getScene();
  const grip = new TransformNode("gun_hand_attachment", scene);
  // The holder applies visual scale; the loader's outer catalog scale is redundant.
  result.root.scaling.setAll(1);
  result.root.parent = grip;
  result.root.setEnabled(true);
  bindLoaderLeftovers(grip, null, result.animationGroups);
  gunShapes.set(grip, measureGunShape(grip, handedTurn(scene)));
  return grip;
}

/** The gun's muzzle and rear end in its held frame, measured while the new grip still sits at the origin. */
function measureGunShape(grip: TransformNode, handed: Quaternion): GunShape {
  grip.computeWorldMatrix(true);
  for (const node of grip.getDescendants(false)) (node as TransformNode).computeWorldMatrix?.(true);
  const toHeld = Matrix.Compose(Vector3.One(), handed, Vector3.Zero());
  let back = 0;
  const point = new Vector3();
  for (const mesh of grip.getChildMeshes(false)) {
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (!positions) continue;
    const toGrip = mesh.getWorldMatrix().multiply(toHeld);
    for (let i = 0; i < positions.length; i += 3) {
      Vector3.TransformCoordinatesFromFloatsToRef(positions[i], positions[i + 1], positions[i + 2], toGrip, point);
      back = Math.min(back, point.y);
    }
  }
  const tag = grip.getDescendants(false).find((node) => node.name === "tag_flash") as TransformNode | undefined;
  const muzzle = tag ? Vector3.TransformCoordinates(tag.getAbsolutePosition(), toHeld) : null;
  return { muzzle, back };
}

/**
 * A held gun's rotation and position in the weapon hand's frame. The gun turns
 * so its bore line passes `BORE_ABOVE_PALM` above the supporting palm, then
 * swings about its own up axis, around its rear end, until the barrel points
 * along the body's front. Without a muzzle the barrel axis is aimed at the palm.
 */
export function gunHold(
  shape: GunShape | undefined,
  scale: number,
  support: GunSupport,
): { turn: Quaternion; position: Vector3 } {
  const reach = support.palm.length();
  const resting = new Vector3(0, 1, 0);
  if (shape?.muzzle) {
    const below = (shape.muzzle.x - BORE_ABOVE_PALM) * scale;
    const across = shape.muzzle.z * scale;
    const along = Math.sqrt(Math.max(reach * reach - below * below - across * across, (reach * reach) / 4));
    resting.set(below, along, across).normalize();
  }
  const rest = new Quaternion();
  Quaternion.FromUnitVectorsToRef(resting, support.palm.scale(1 / reach), rest);
  // Swing the barrel, flattened square to the gun's up, onto the body's front flattened the same way
  const up = new Vector3(1, 0, 0).rotateByQuaternionToRef(rest, new Vector3());
  const flatten = (v: Vector3) => v.subtract(up.scale(Vector3.Dot(v, up))).normalize();
  const barrel = flatten(new Vector3(0, 1, 0).rotateByQuaternionToRef(rest, new Vector3()));
  const front = flatten(support.forward);
  const yaw = Math.atan2(Vector3.Dot(Vector3.Cross(barrel, front), up), Vector3.Dot(barrel, front));
  const swing = Quaternion.RotationAxis(up, Number.isFinite(yaw) ? yaw : 0);
  const rear = new Vector3(0, (shape?.back ?? 0) * scale, 0).rotateByQuaternionToRef(rest, new Vector3());
  return {
    turn: swing.multiply(rest),
    position: rear.subtract(rear.rotateByQuaternionToRef(swing, new Vector3())),
  };
}

/**
 * The packaged gun's +X barrel follows the right hand's +Y finger direction,
 * held on the body's supporting palm and along its front (`gunSupport`, see
 * `gunHold`).
 */
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
    const scale = (visualScale / (player.modelScale ?? playerScale)) * 0.5;
    grip.scaling.setAll(scale);
    const handed = handedTurn(player.mesh.getScene());
    if (player.gunSupport) {
      const hold = gunHold(gunShapes.get(grip), scale, player.gunSupport);
      // The hold is in the weapon hand's frame, so it applies after the handedness turn
      grip.rotationQuaternion = hold.turn.multiply(handed);
      grip.position.copyFrom(hold.position);
    } else {
      grip.rotationQuaternion = handed;
    }
  } else {
    grip.parent = player.anchor;
    grip.position.set(0, 30, 0);
    grip.scaling.setAll(visualScale);
    grip.rotationQuaternion = null;
    grip.rotation.setAll(0);
  }
  grip.setEnabled(true);
  player.attachedWeapon = grip;
}
