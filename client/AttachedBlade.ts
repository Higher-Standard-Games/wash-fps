import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { PlayerModelInstance } from "../../../engine/animation/PlayerModelManager";
import type { ModelLoadResult } from "../../../engine/loader/model/ModelLoader";
import { bindLoaderLeftovers } from "../../../engine/loader/model/ModelSourceCache";

/** glTF's left-handed conversion reverses export X; this lays the blade along the hand's fingers (+Y). */
function alongFingers(scene: Scene): Quaternion {
  const modelXSign = scene.useRightHandedSystem ? 1 : -1;
  return Quaternion.FromEulerAngles(Math.PI, 0, (-modelXSign * Math.PI) / 2);
}

/** A blade laid along the fingers (+Y), in its grip's units before scale. */
interface BladeShape {
  /** The normal of its flat faces: +X or +Z. */
  thin: Vector3;
  /** How far along +Y a fist holds it: three quarters of the way from the pommel to the guard. */
  holdAt: number;
}

const bladeShapes = new WeakMap<TransformNode, BladeShape>();

/** Attach the normalized +X blade without discarding its GLB export transforms. */
export function attachBladeToPlayer(
  result: ModelLoadResult,
  player: PlayerModelInstance,
  visualScale: number,
  playerScale: number,
): TransformNode {
  const scene = player.mesh.getScene();
  const grip = new TransformNode("blade_hand_attachment", scene);
  const modelXSign = scene.useRightHandedSystem ? 1 : -1;
  const offset = new TransformNode("blade_grip_offset", scene);
  offset.parent = grip;
  // The packaged export's handle centre is at X=-0.45 model units.
  offset.position.x = 0.45 * modelXSign;
  result.root.parent = offset;
  result.root.setEnabled(true);
  bindLoaderLeftovers(grip, null, result.animationGroups);
  bladeShapes.set(grip, measureBladeShape(grip, alongFingers(scene)));
  holdBladeGrip(grip, player, visualScale, playerScale);
  return grip;
}

/**
 * The blade's thin axis and where a fist holds it, measured while the new grip
 * sits at the origin. The guard is the widest point in the lowest third.
 */
function measureBladeShape(grip: TransformNode, along: Quaternion): BladeShape {
  grip.computeWorldMatrix(true);
  for (const node of grip.getDescendants(false)) (node as TransformNode).computeWorldMatrix?.(true);
  const toHeld = Matrix.Compose(Vector3.One(), along, Vector3.Zero());
  const points: Vector3[] = [];
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const mesh of grip.getChildMeshes(false)) {
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (!positions) continue;
    const toGrip = mesh.getWorldMatrix().multiply(toHeld);
    for (let i = 0; i < positions.length; i += 3) {
      const point = Vector3.TransformCoordinatesFromFloatsToRef(
        positions[i],
        positions[i + 1],
        positions[i + 2],
        toGrip,
        new Vector3(),
      );
      points.push(point);
      min.minimizeInPlace(point);
      max.maximizeInPlace(point);
    }
  }
  const thin = max.x - min.x <= max.z - min.z ? new Vector3(1, 0, 0) : new Vector3(0, 0, 1);
  if (!points.length) return { thin, holdAt: 0 };
  const lowest = min.y + (max.y - min.y) / 3;
  let guard = min.y;
  let widest = -1;
  for (const point of points) {
    if (point.y > lowest) continue;
    const width = Math.hypot(point.x, point.z);
    if (width > widest) {
      widest = width;
      guard = point.y;
    }
  }
  return { thin, holdAt: min.y + (guard - min.y) * 0.75 };
}

/** Put a blade's grip (from `attachBladeToPlayer`) in a player's right hand. */
export function holdBladeGrip(
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
    grip.scaling.setAll(visualScale / (player.modelScale ?? playerScale));
  } else {
    grip.parent = player.anchor;
    grip.position.set(0, 30, 0);
    grip.scaling.setAll(visualScale);
  }
  bladeUpright.delete(grip);
  setBladeStance(grip, player, false);
  grip.setEnabled(true);
  player.attachedWeapon = grip;
}

/** Whether each held blade stands up in the stance, so its placement is written only when it changes. */
const bladeUpright = new WeakMap<TransformNode, boolean>();

/**
 * The turn, in the weapon hand's frame, that carries a blade laid along the
 * fingers (+Y, thin across `thin`) onto `axis` with its flat faces toward
 * `side`, so an edge leads.
 */
export function bladeStanceTurn(thin: Vector3, axis: Vector3, side: Vector3): Quaternion {
  const length = Vector3.Up();
  const from = Quaternion.RotationQuaternionFromAxis(thin, Vector3.Cross(length, thin), length);
  const to = Quaternion.RotationQuaternionFromAxis(side, Vector3.Cross(axis, side), axis);
  return to.multiply(Quaternion.Inverse(from));
}

/**
 * Stand a held blade up in the fists while the blade stance holds the arms
 * (`bladeStance`), or lay it along the fingers, as the swing holds it.
 */
export function setBladeStance(grip: TransformNode, player: PlayerModelInstance, upright: boolean): void {
  const stance = player.bladeStance;
  const stands = upright && !!stance && grip.parent === player.weaponHand;
  if (bladeUpright.get(grip) === stands) return;
  bladeUpright.set(grip, stands);
  const along = alongFingers(player.mesh.getScene());
  if (stands && stance) {
    const shape = bladeShapes.get(grip) ?? { thin: new Vector3(0, 0, 1), holdAt: 0 };
    // The stance turn is in the weapon hand's frame, so it applies after laying the blade along the fingers
    grip.rotationQuaternion = bladeStanceTurn(shape.thin, stance.axis, stance.side).multiply(along);
    // Slide the blade along its axis so the fist holds the handle just below the guard
    grip.position.copyFrom(stance.fist.subtract(stance.axis.scale(shape.holdAt * grip.scaling.x)));
  } else {
    grip.rotationQuaternion = along;
    if (grip.parent === player.weaponHand) grip.position.setAll(0);
  }
}
