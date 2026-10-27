import type { Bone } from "@babylonjs/core/Bones/bone";
import type { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { Space } from "@babylonjs/core/Maths/math.axis";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Observer } from "@babylonjs/core/Misc/observable";
import type { Ragdoll } from "@babylonjs/core/Physics/v2/ragdoll";
import type { Scene } from "@babylonjs/core/scene";

interface Binding {
  bone: Bone;
  collider: TransformNode;
  bindRotation: Quaternion;
}

interface RigEntry {
  bone: Bone;
  parent: number;
  binding: Binding | undefined;
  localScale: number;
  worldScale: number;
  worldRotation: Quaternion;
}

/** Returns zero for mirrored, nonuniform, sheared or singular transforms. */
function uniformScale(matrix: Matrix): number {
  const m = matrix.m;
  const xx = m[0] * m[0] + m[1] * m[1] + m[2] * m[2];
  const yy = m[4] * m[4] + m[5] * m[5] + m[6] * m[6];
  const zz = m[8] * m[8] + m[9] * m[9] + m[10] * m[10];
  const tolerance = xx * 1e-5;
  if (
    !Number.isFinite(xx + yy + zz) ||
    xx <= 0 ||
    Math.abs(xx - yy) > tolerance ||
    Math.abs(xx - zz) > tolerance ||
    Math.abs(m[0] * m[4] + m[1] * m[5] + m[2] * m[6]) > tolerance ||
    Math.abs(m[0] * m[8] + m[1] * m[9] + m[2] * m[10]) > tolerance ||
    Math.abs(m[4] * m[8] + m[5] * m[9] + m[6] * m[10]) > tolerance ||
    matrix.determinant() <= 0
  )
    return 0;
  return Math.sqrt(xx);
}

/** Owns only the visual transfer from Babylon's ragdoll colliders to its unlinked bones. */
export class BatchedPoseSync {
  private readonly meshRotation = Quaternion.Identity();
  private readonly meshWorldRotation = Quaternion.Identity();
  private readonly correction = Quaternion.Identity();
  private readonly desired = Quaternion.Identity();
  private readonly inverseParent = Quaternion.Identity();
  private readonly local = Quaternion.Identity();
  private readonly scale = Vector3.One();
  private readonly rootPosition = Vector3.Zero();
  private readonly inverseMesh = Matrix.Identity();
  private observer: Observer<Scene> | null = null;
  private meshDisposed: ReturnType<TransformNode["onDisposeObservable"]["addOnce"]> = null;
  private disposed = false;

  private constructor(
    private readonly skeleton: Skeleton,
    private readonly mesh: TransformNode,
    private readonly ragdoll: Ragdoll,
    private readonly entries: RigEntry[],
    private readonly bindings: Binding[],
    private readonly root: Binding,
  ) {}

  /** Call immediately after ragdoll(), before the first physics/render step. Unsupported rigs stay native. */
  static create(
    skeleton: Skeleton,
    mesh: TransformNode,
    ragdoll: Ragdoll,
    boneNames: readonly string[],
  ): BatchedPoseSync | null {
    if (ragdoll.pauseSync || skeleton.bones.length === 0 || new Set(boneNames).size !== boneNames.length) return null;
    const bones = new Map(skeleton.bones.map((bone) => [bone.name, bone]));
    const bindings: Binding[] = [];
    for (const [index, name] of boneNames.entries()) {
      const bone = bones.get(name);
      const collider = ragdoll.getAggregate(index)?.body?.transformNode;
      if (!bone || !collider?.rotationQuaternion) return null;
      bindings.push({ bone, collider, bindRotation: bone.getRotationQuaternion(Space.WORLD) });
    }
    const byBone = new Map(bindings.map((binding) => [binding.bone, binding]));
    const entries: RigEntry[] = [];
    const indices = new Map<Bone, number>();
    for (const bone of skeleton.bones) {
      const parentBone = bone.getParent();
      const parent = parentBone ? indices.get(parentBone) : -1;
      if (parent === undefined || (!parentBone && entries.length > 0)) return null;
      if (bone.getTransformNode() || bone.getAbsoluteInverseBindMatrix().determinant() <= 0) return null;
      entries.push({
        bone,
        parent,
        binding: byBone.get(bone),
        localScale: 1,
        worldScale: 1,
        worldRotation: Quaternion.Identity(),
      });
      indices.set(bone, entries.length - 1);
    }
    const root = byBone.get(entries[0].bone);
    if (!root) return null;
    // Native sync writes the root, then the configured bones in order. Ancestors must precede descendants.
    const visited = new Set<Bone>();
    for (const binding of [root, ...bindings.filter((binding) => binding !== root)]) {
      for (let parent = binding.bone.getParent(); parent; parent = parent.getParent()) {
        if (byBone.has(parent) && !visited.has(parent)) return null;
      }
      visited.add(binding.bone);
    }
    const sync = new BatchedPoseSync(skeleton, mesh, ragdoll, entries, bindings, root);
    if (!sync.canBatch()) return null;
    // All allocations and local-pose decomposition happen before the first sync.
    for (const entry of entries) void entry.bone.rotationQuaternion;
    ragdoll.pauseSync = true;
    sync.observer = skeleton.getScene().onBeforeRenderObservable.add(() => sync.update());
    sync.meshDisposed = mesh.onDisposeObservable.addOnce(() => sync.dispose());
    return sync;
  }

  private canBatch(): boolean {
    const pose = this.skeleton.getPoseMatrix();
    if ((pose && !pose.isIdentity()) || this.skeleton.bones.length !== this.entries.length) return false;
    const localScale = this.mesh.scaling.x;
    const worldScale = uniformScale(this.mesh.getWorldMatrix());
    if (
      localScale <= 0 ||
      this.mesh.scaling.y !== localScale ||
      this.mesh.scaling.z !== localScale ||
      !worldScale ||
      Math.abs(worldScale - localScale) > localScale * 1e-5
    )
      return false;
    for (const entry of this.entries) {
      entry.localScale = uniformScale(entry.bone.getLocalMatrix());
      if (!entry.localScale || entry.bone.getTransformNode()) return false;
    }
    return true;
  }

  private desiredRotation(binding: Binding): void {
    const rotation = this.mesh.rotationQuaternion;
    if (rotation) this.meshRotation.copyFrom(rotation);
    else
      Quaternion.FromEulerAnglesToRef(
        this.mesh.rotation.x,
        this.mesh.rotation.y,
        this.mesh.rotation.z,
        this.meshRotation,
      );
    // Babylon's correction uses the mesh's LOCAL rotation and the initial mesh-free bone rotation.
    this.meshRotation.multiplyToRef(binding.bindRotation, this.correction);
    binding.collider.rotationQuaternion!.multiplyToRef(this.correction, this.desired);
  }

  private update(): void {
    if (this.disposed) return;
    if (!this.ragdoll.pauseSync) {
      this.dispose();
      return;
    }
    this.mesh.getWorldMatrix().invertToRef(this.inverseMesh);
    Vector3.TransformCoordinatesToRef(this.root.collider.position, this.inverseMesh, this.rootPosition);
    if (!this.canBatch()) {
      // Match native world setters on the same frame when the transform no longer supports batching.
      this.desiredRotation(this.root);
      this.root.bone.setRotationQuaternion(this.desired, Space.WORLD, this.mesh);
      this.root.bone.setAbsolutePosition(this.rootPosition);
      for (const binding of this.bindings) {
        if (binding === this.root) continue;
        this.desiredRotation(binding);
        binding.bone.setRotationQuaternion(this.desired, Space.WORLD, this.mesh);
      }
      return;
    }
    this.mesh.getWorldMatrix().decompose(undefined, this.meshWorldRotation, undefined);
    for (const entry of this.entries) {
      const parent = entry.parent < 0 ? null : this.entries[entry.parent];
      const parentRotation = parent?.worldRotation ?? this.meshWorldRotation;
      const parentScale = parent?.worldScale ?? 1;
      if (entry.binding) {
        this.desiredRotation(entry.binding);
        parentRotation.conjugateToRef(this.inverseParent);
        this.inverseParent.multiplyToRef(this.desired, this.local);
        entry.bone.setRotationQuaternion(this.local, Space.LOCAL);
        // Native world-space rotation setters cancel the bone's inherited uniform scale.
        this.scale.setAll(1 / parentScale);
        entry.bone.setScale(this.scale);
        entry.worldRotation.copyFrom(this.desired);
        entry.worldScale = 1;
        if (entry.binding === this.root) entry.bone.setPosition(this.rootPosition, Space.LOCAL);
      } else {
        parentRotation.multiplyToRef(entry.bone.rotationQuaternion, entry.worldRotation);
        entry.worldScale = parentScale * entry.localScale;
      }
    }
    this.skeleton.computeAbsoluteMatrices();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.skeleton.getScene().onBeforeRenderObservable.remove(this.observer);
    this.mesh.onDisposeObservable.remove(this.meshDisposed);
    this.observer = null;
    this.meshDisposed = null;
    this.ragdoll.pauseSync = false;
  }
}
