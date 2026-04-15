/**
 * Vec3 Math Helpers
 *
 * Shared vector math utilities for movement simulation.
 * Both allocating and mutating (zero-alloc) variants provided.
 */

import type { Vec3 } from "../../../engine/network/components/TransformComponent";

// ================== Allocating Helpers ==================

/** Shared frozen zero — never allocate a new { x:0, y:0, z:0 } */
export const VEC3_ZERO: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: 0 });

export function vec3Zero(): Vec3 {
  return { x: 0, y: 0, z: 0 };
}

export function vec3Clone(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

export function vec3Add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function vec3Scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function vec3Length(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

export function vec3LengthXZ(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.z * v.z);
}

export function vec3Normalize(v: Vec3): Vec3 {
  const len = vec3Length(v);
  if (len < 0.0001) return vec3Zero();
  return vec3Scale(v, 1 / len);
}

export function vec3Dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function vec3DotXZ(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.z * b.z;
}

// ================== Mutating Variants (zero-alloc, for hot paths) ==================

/** out = origin + dir * scale  (writes into out, no allocation) */
export function vec3MulAdd(out: Vec3, origin: Vec3, dir: Vec3, scale: number): void {
  out.x = origin.x + dir.x * scale;
  out.y = origin.y + dir.y * scale;
  out.z = origin.z + dir.z * scale;
}
