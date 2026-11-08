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
import { createGunGrip, holdGunGrip } from "../AttachedGun";

it.each([false, true])(
  "keeps gun geometry and muzzle in one hand-aligned model space (right-handed=%s)",
  (rightHanded) => {
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
      const player = { anchor, mesh: body, skeleton, attachedWeapon: null } as unknown as PlayerModelInstance;
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
      expect(grip.parent).toBe(hand);
      expect(geometry.parent).toBe(gltf);
      expect(part.parent).toBe(gltf);
      expect(part.position.asArray()).toEqual([12, 8, 0]);
      expect(tag.parent).toBe(gltf);
      const forward = Vector3.TransformNormal(Vector3.Right(), gltf.computeWorldMatrix(true)).normalize();
      expect(forward.y).toBeCloseTo(1);
      const up = Vector3.TransformNormal(Vector3.Up(), gltf.computeWorldMatrix(true)).normalize();
      expect(up.x).toBeCloseTo(1);
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
