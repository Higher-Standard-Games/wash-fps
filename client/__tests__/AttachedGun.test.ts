import { Bone } from "@babylonjs/core/Bones/bone";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { expect, it } from "vitest";
import type { PlayerModelInstance } from "../../../../engine/animation/PlayerModelManager";
import { disposeModelResources } from "../../../../engine/loader/model/ModelSourceCache";
import { createGunGrip, gunHold, holdGunGrip } from "../AttachedGun";

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  "keeps gun geometry and muzzle in one hand-aligned model space (right-handed=%s, support=%s)",
  (rightHanded, supported) => {
    const engine = new NullEngine(),
      scene = new Scene(engine);
    scene.useRightHandedSystem = rightHanded;
    try {
      const anchor = new TransformNode("player", scene),
        body = MeshBuilder.CreateBox("body", {}, scene);
      body.parent = anchor;
      body.scaling.setAll(36);
      body.computeWorldMatrix(true);
      const skeleton = new Skeleton("player", "player", scene),
        hand = new Bone("mixamorig:RightHand", skeleton, null, Matrix.Identity());
      // A supporting palm below the barrel and ahead of the grip, and the body's front
      const gunSupport = supported
        ? { palm: new Vector3(-12, 30, 2), forward: new Vector3(-0.2, 0.95, 0.1).normalize() }
        : undefined;
      const player = {
        anchor,
        mesh: body,
        skeleton,
        attachedWeapon: null,
        gunSupport,
      } as unknown as PlayerModelInstance;
      const root = new TransformNode("loader", scene);
      root.scaling.setAll(2);
      const gltf = new TransformNode("__root__", scene);
      gltf.parent = root;
      if (!rightHanded) {
        gltf.rotation.y = Math.PI;
        gltf.scaling.z = -1;
      }
      const geometry = MeshBuilder.CreateBox("gun", { width: 40, height: 8, depth: 5 }, scene);
      geometry.parent = gltf;
      const part = MeshBuilder.CreateBox("sight", {}, scene);
      part.parent = gltf;
      part.position.set(12, 8, 0);
      const tag = new TransformNode("tag_flash", scene);
      tag.parent = gltf;
      tag.position.set(30, 6, 0);
      const grip = createGunGrip({ root, meshes: [geometry, part], skeletons: [], animationGroups: [] });
      holdGunGrip(grip, player, 2, 36);
      const held = gunSupport ? fittedTurn(grip, rightHanded) : undefined;
      expect(grip.parent).toBe(hand);
      expect(geometry.parent).toBe(gltf);
      expect(part.parent).toBe(gltf);
      expect(part.position.asArray()).toEqual([12, 8, 0]);
      expect(tag.parent).toBe(gltf);
      // The barrel follows the fingers (+Y) with its top on the thumb side (+X), turned by the support
      const expectedForward = Vector3.Up().rotateByQuaternionToRef(held ?? Quaternion.Identity(), new Vector3());
      const expectedUp = Vector3.Right().rotateByQuaternionToRef(held ?? Quaternion.Identity(), new Vector3());
      const forward = Vector3.TransformNormal(Vector3.Right(), gltf.computeWorldMatrix(true)).normalize();
      expect(forward.x).toBeCloseTo(expectedForward.x);
      expect(forward.y).toBeCloseTo(expectedForward.y);
      expect(forward.z).toBeCloseTo(expectedForward.z);
      const up = Vector3.TransformNormal(Vector3.Up(), gltf.computeWorldMatrix(true)).normalize();
      expect(up.x).toBeCloseTo(expectedUp.x);
      expect(up.y).toBeCloseTo(expectedUp.y);
      grip.computeWorldMatrix(true);
      tag.computeWorldMatrix(true);
      expect(tag.getAbsolutePosition().subtract(grip.getAbsolutePosition()).length()).toBeCloseTo(
        Math.sqrt(30 ** 2 + 6 ** 2),
      );
      expect(player.attachedWeapon).toBe(grip);
      disposeModelResources([grip]);
      expect(root.isDisposed()).toBe(true);
      expect(part.isDisposed()).toBe(true);
      expect(tag.isDisposed()).toBe(true);
    } finally {
      engine.dispose();
    }
  },
);

/** The turn holdGunGrip applied: its rotation with the handedness turn taken back off. */
function fittedTurn(grip: TransformNode, rightHanded: boolean): Quaternion {
  const handed = Quaternion.FromEulerAngles(rightHanded ? Math.PI : 0, 0, -Math.PI / 2);
  return grip.rotationQuaternion!.multiply(Quaternion.Inverse(handed));
}

const turned = (q: Quaternion, v: Vector3) => v.rotateByQuaternionToRef(q, new Vector3());
const palm = new Vector3(-8, 30, 4);
/** A gun whose muzzle sits 6 above and 1 beside the grip line, 60 ahead, with a stock 10 behind. */
const shape = { muzzle: new Vector3(6, 60, 1), back: -10 };

/** The turn that rests the bore line 4.3 above the palm, before any swing. */
function restingTurn(): Quaternion {
  const reach = palm.length();
  const below = 6 - 4.3;
  const resting = new Vector3(below, Math.sqrt(reach * reach - below * below - 1), 1).normalize();
  const rest = new Quaternion();
  Quaternion.FromUnitVectorsToRef(resting, palm.normalizeToNew(), rest);
  return rest;
}

it("rests the bore line 4.3 units above the supporting palm, whatever hangs below it", () => {
  const rest = restingTurn();
  // With the body's front along the resting barrel there is nothing to swing
  const hold = gunHold(shape, 1, { palm, forward: turned(rest, Vector3.Up()) });
  expect(hold.position.length()).toBeLessThan(1e-4);
  const reach = palm.length();
  const below = new Vector3(6 - 4.3, Math.sqrt(reach * reach - (6 - 4.3) ** 2 - 1), 1);
  expect(Vector3.Distance(turned(hold.turn, below), palm)).toBeLessThan(1e-3);
});

it("swings the barrel along the body's front about the gun's up axis, around its rear end", () => {
  const rest = restingTurn();
  const forward = new Vector3(0.3, 0.9, 0.2).normalize();
  const hold = gunHold(shape, 1, { palm, forward });
  const up = turned(hold.turn, new Vector3(1, 0, 0));
  // The swing is about the resting gun's up, so up itself does not move
  expect(Vector3.Distance(up, turned(rest, new Vector3(1, 0, 0)))).toBeLessThan(1e-4);
  const flatten = (v: Vector3) => v.subtract(up.scale(Vector3.Dot(v, up))).normalize();
  expect(Vector3.Distance(flatten(turned(hold.turn, Vector3.Up())), flatten(forward))).toBeLessThan(1e-4);
  // The rear end stays where resting put it
  const rear = new Vector3(0, -10, 0);
  expect(Vector3.Distance(turned(hold.turn, rear).add(hold.position), turned(rest, rear))).toBeLessThan(1e-4);
});

it("scales the gun's shape, its rest above the palm included, before fitting it", () => {
  const half = gunHold(shape, 0.5, { palm, forward: Vector3.Up() });
  // At full scale the same fit needs the bore (6 - 4.3) * 0.5 above the rest and the muzzle 0.5 aside
  const same = gunHold({ muzzle: new Vector3(4.3 + 1.7 * 0.5, 30, 0.5), back: -5 }, 1, {
    palm,
    forward: Vector3.Up(),
  });
  expect(Vector3.Distance(turned(half.turn, Vector3.Up()), turned(same.turn, Vector3.Up()))).toBeLessThan(1e-3);
});

it("aims the barrel itself at the palm when the gun has no muzzle", () => {
  const toPalm = palm.normalizeToNew();
  const hold = gunHold(undefined, 1, { palm, forward: toPalm });
  expect(Vector3.Distance(turned(hold.turn, Vector3.Up()), toPalm)).toBeLessThan(1e-6);
});
