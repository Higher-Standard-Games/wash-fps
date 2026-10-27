import fs from "node:fs";
import { Bone } from "@babylonjs/core/Bones/bone";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { Ragdoll } from "@babylonjs/core/Physics/v2/ragdoll";
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent";
import type { PhysicsEngine } from "@babylonjs/core/Physics/v2/physicsEngine";
import { Scene } from "@babylonjs/core/scene";
import HavokPhysics from "@babylonjs/havok";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BatchedPoseSync } from "../BatchedPoseSync";
import fixture from "./fixtures/vanguard-rig.json";

let havok: Awaited<ReturnType<typeof HavokPhysics>>;
interface TestRig {
  engine: NullEngine;
  scene: Scene;
  anchor: TransformNode;
  mesh: Mesh;
  skeleton: Skeleton;
  ragdoll: Ragdoll;
  sync: BatchedPoseSync | null;
}
const rigs: TestRig[] = [];
beforeAll(async () => {
  const bytes = new Uint8Array(fs.readFileSync("public/wasm/HavokPhysics.wasm"));
  havok = await HavokPhysics({ wasmBinary: bytes.buffer });
});
afterEach(() => {
  for (const item of rigs.splice(0)) {
    item.sync?.dispose();
    item.ragdoll.dispose();
    item.scene.dispose();
    item.engine.dispose();
  }
  vi.restoreAllMocks();
});

function rig(
  options: { yaw?: number; localRotation?: Quaternion; scale?: Vector3; parentScale?: number } = {},
): TestRig {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.enablePhysics(new Vector3(0, -800, 0), new HavokPlugin(true, havok));
  const anchor = new TransformNode("anchor", scene);
  anchor.position.set(83, 100, -41);
  anchor.rotation.y = options.yaw ?? 0;
  anchor.scaling.setAll(options.parentScale ?? 1);
  const mesh = new Mesh("__root__", scene);
  mesh.parent = anchor;
  mesh.scaling.copyFrom(options.scale ?? new Vector3(36, 36, 36));
  mesh.rotationQuaternion = options.localRotation?.clone() ?? Quaternion.Identity();
  mesh.computeWorldMatrix(true);
  const skeleton = new Skeleton("vanguard", "vanguard", scene);
  for (const data of fixture.bones) {
    const bone = new Bone(
      data.name,
      skeleton,
      data.parent < 0 ? null : skeleton.bones[data.parent],
      Matrix.FromArray(data.local),
    );
    bone.updateMatrix(Matrix.FromArray(data.bind), true, false);
  }
  mesh.skeleton = skeleton;
  skeleton.computeAbsoluteMatrices(true);
  const ragdoll = new Ragdoll(
    skeleton,
    mesh,
    fixture.controlledBones.map((bone) => ({ bone, width: 3, height: 4, depth: 3 })),
  );
  ragdoll.ragdoll();
  const item = { engine, scene, anchor, mesh, skeleton, ragdoll, sync: null as BatchedPoseSync | null };
  rigs.push(item);
  return item;
}

function attach(item: ReturnType<typeof rig>) {
  item.sync = BatchedPoseSync.create(item.skeleton, item.mesh, item.ragdoll, fixture.controlledBones);
  return item.sync;
}

function random(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function colliderPoses(items: ReturnType<typeof rig>[], next: () => number) {
  for (let i = 0; i < fixture.controlledBones.length; i++) {
    const rotation = Quaternion.FromEulerAngles(next() * 2 - 1, next() * 6 - 3, next() * 2 - 1);
    const position = new Vector3(100 + next() * 30, 100 + next() * 20, -20 + next() * 20);
    for (const item of items) {
      const node = item.ragdoll.getAggregate(i).body.transformNode;
      node.rotationQuaternion!.copyFrom(rotation);
      node.position.copyFrom(position);
    }
  }
}

function poseError(native: ReturnType<typeof rig>, candidate: ReturnType<typeof rig>) {
  let matrices = 0;
  let sockets = 0;
  for (const item of [native, candidate]) item.skeleton.computeAbsoluteMatrices();
  for (let i = 0; i < fixture.bones.length; i++) {
    const a = native.skeleton.bones[i].getAbsoluteMatrix().m;
    const b = candidate.skeleton.bones[i].getAbsoluteMatrix().m;
    for (let c = 0; c < 16; c++) matrices = Math.max(matrices, Math.abs(a[c] - b[c]));
  }
  for (const name of ["mixamorig:RightHand", "mixamorig:Spine1", "mixamorig:Head"]) {
    const a = native.skeleton.bones.find((bone) => bone.name === name)!;
    const b = candidate.skeleton.bones.find((bone) => bone.name === name)!;
    sockets = Math.max(
      sockets,
      Vector3.Distance(a.getAbsolutePosition(native.mesh), b.getAbsolutePosition(candidate.mesh)),
    );
  }
  return { matrices, sockets };
}

describe("batched Vanguard ragdoll pose", () => {
  it("matches native absolute matrices, sockets and skin palettes with one dirty rebuild per sync", () => {
    const next = random(417);
    for (const yaw of [0, 0.7, -2.3]) {
      const options = { yaw, localRotation: Quaternion.FromEulerAngles(0.2, 0.4, -0.1) };
      const native = rig(options);
      const candidate = rig(options);
      expect(attach(candidate)).not.toBeNull();
      const prepare = vi.spyOn(candidate.skeleton.bones[0], "computeAbsoluteMatrices");
      let maxMatrixError = 0;
      let maxSocketError = 0;
      for (let frame = 0; frame < 100; frame++) {
        colliderPoses([native, candidate], next);
        const calls = prepare.mock.calls.length;
        native.scene.onBeforeRenderObservable.notifyObservers(native.scene);
        candidate.scene.onBeforeRenderObservable.notifyObservers(candidate.scene);
        expect(prepare.mock.calls.length - calls).toBe(1);
        const error = poseError(native, candidate);
        maxMatrixError = Math.max(maxMatrixError, error.matrices);
        maxSocketError = Math.max(maxSocketError, error.sockets);
      }
      expect(maxMatrixError).toBeLessThan(1e-5);
      expect(maxSocketError).toBeLessThan(0.001);
      native.skeleton.prepare(true);
      candidate.skeleton.prepare(true);
      const a = native.skeleton.getTransformMatrices(native.mesh);
      const b = candidate.skeleton.getTransformMatrices(candidate.mesh);
      expect(a.length).toBe(b.length);
      for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(1e-5);
    }
  });

  it.each([{ scale: new Vector3(36, 40, 36) }, { scale: new Vector3(36, 36, -36) }, { parentScale: 2 }])(
    "leaves unsupported initial scaling on Babylon's native sync: %o",
    (options) => {
      const item = rig(options);
      const before = item.scene.onBeforeRenderObservable.observers.length;
      expect(attach(item)).toBeNull();
      expect(item.ragdoll.pauseSync).toBe(false);
      expect(item.scene.onBeforeRenderObservable.observers.length).toBe(before);
    },
  );

  it("falls back on the same frame when mesh scaling changes, and resumes batching when restored", () => {
    const native = rig({ yaw: 0.7 });
    const candidate = rig({ yaw: 0.7 });
    expect(attach(candidate)).not.toBeNull();
    const next = random(53);
    for (const scale of [
      new Vector3(36, 36, 36),
      new Vector3(36, 40, 36),
      new Vector3(36, 36, -36),
      new Vector3(36, 36, 36),
    ]) {
      for (const item of [native, candidate]) {
        item.mesh.scaling.copyFrom(scale);
        item.mesh.computeWorldMatrix(true);
      }
      colliderPoses([native, candidate], next);
      for (const item of [native, candidate]) item.scene.onBeforeRenderObservable.notifyObservers(item.scene);
      const error = poseError(native, candidate);
      expect(error.matrices).toBeLessThan(1e-5);
      expect(error.sockets).toBeLessThan(0.001);
    }
  });

  it("releases its observers and native pause ownership on explicit or mesh disposal", () => {
    const item = rig();
    const sceneCount = item.scene.onBeforeRenderObservable.observers.length;
    const meshCount = item.mesh.onDisposeObservable.observers.length;
    const sync = attach(item)!;
    expect(item.ragdoll.pauseSync).toBe(true);
    expect(item.scene.onBeforeRenderObservable.observers.length).toBe(sceneCount + 1);
    sync.dispose();
    sync.dispose();
    expect(item.ragdoll.pauseSync).toBe(false);
    // Babylon removes observers on a deferred callback; marked observers no longer run.
    expect(item.scene.onBeforeRenderObservable.observers.filter((o) => !o._willBeUnregistered).length).toBe(sceneCount);
    expect(item.mesh.onDisposeObservable.observers.filter((o) => !o._willBeUnregistered).length).toBe(meshCount);
    item.sync = null;
    expect(attach(item)).not.toBeNull();
    item.mesh.dispose();
    expect(item.ragdoll.pauseSync).toBe(false);
  });

  it("preserves exact Havok collider trajectories and velocities over a contacting fall", () => {
    const native = rig({ yaw: 0.7 });
    const candidate = rig({ yaw: 0.7 });
    expect(attach(candidate)).not.toBeNull();
    for (const item of [native, candidate]) {
      const floor = MeshBuilder.CreateBox("floor", { width: 600, height: 4, depth: 600 }, item.scene);
      floor.position.y = -2;
      new PhysicsAggregate(floor, 3, { mass: 0 }, item.scene);
      for (let i = 0; i < fixture.controlledBones.length; i++) {
        item.ragdoll.getAggregate(i).body.setLinearVelocity(new Vector3(20, 40, 10));
      }
    }
    for (let frame = 0; frame < 500; frame++) {
      for (const item of [native, candidate]) {
        (item.scene.getPhysicsEngine() as PhysicsEngine)._step(1 / 125);
        item.scene.onBeforeRenderObservable.notifyObservers(item.scene);
      }
      for (let i = 0; i < fixture.controlledBones.length; i++) {
        const a = native.ragdoll.getAggregate(i).body;
        const b = candidate.ragdoll.getAggregate(i).body;
        expect(a.transformNode.position.asArray()).toEqual(b.transformNode.position.asArray());
        expect(a.transformNode.rotationQuaternion!.asArray()).toEqual(b.transformNode.rotationQuaternion!.asArray());
        expect(a.getLinearVelocity().asArray()).toEqual(b.getLinearVelocity().asArray());
        expect(a.getAngularVelocity().asArray()).toEqual(b.getAngularVelocity().asArray());
      }
      expect(poseError(native, candidate).sockets).toBeLessThan(0.001);
    }
    const heights = fixture.controlledBones.map((_, i) => native.ragdoll.getAggregate(i).body.transformNode.position.y);
    expect(Math.min(...heights)).toBeGreaterThan(0);
    expect(Math.min(...heights)).toBeLessThan(6);
  });
});
