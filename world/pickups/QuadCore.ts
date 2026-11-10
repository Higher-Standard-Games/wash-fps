import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { VertexBuffer } from "@babylonjs/core/Meshes/buffer";
import type { Geometry } from "@babylonjs/core/Meshes/geometry";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";
import { innermostPart } from "./HealthTint";

/** The core turns once every this many seconds, in the badge's own plane. */
const SPIN_PERIOD = 3;
/** How brightly the core glows in its own colours: fullbright, a little over for bloom. */
const CORE_GLOW = 1.4;

/**
 * The model's innermost part as a mesh of its own: its vertices renumbered from
 * 0, and the centre it turns about. The rest of the model keeps every other
 * triangle.
 */
export function splitCore(
  positions: ArrayLike<number>,
  normals: ArrayLike<number> | null,
  uvs: ArrayLike<number> | null,
  indices: ArrayLike<number>,
): { core: VertexData; centre: [number, number, number]; rest: number[] } | null {
  const triangles = innermostPart(positions, indices);
  if (triangles.length === 0 || triangles.length * 3 === indices.length) return null;
  const inCore = new Set(triangles);
  const remap = new Map<number, number>();
  const corePositions: number[] = [];
  const coreNormals: number[] = [];
  const coreUvs: number[] = [];
  const coreIndices: number[] = [];
  const rest: number[] = [];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < indices.length; t += 3) {
    if (!inCore.has(t)) {
      rest.push(indices[t], indices[t + 1], indices[t + 2]);
      continue;
    }
    for (let k = 0; k < 3; k++) {
      const v = indices[t + k];
      let at = remap.get(v);
      if (at === undefined) {
        at = remap.size;
        remap.set(v, at);
        for (let a = 0; a < 3; a++) {
          corePositions.push(positions[v * 3 + a]);
          min[a] = Math.min(min[a], positions[v * 3 + a]);
          max[a] = Math.max(max[a], positions[v * 3 + a]);
          if (normals) coreNormals.push(normals[v * 3 + a]);
        }
        if (uvs) coreUvs.push(uvs[v * 2], uvs[v * 2 + 1]);
      }
      coreIndices.push(at);
    }
  }
  const centre: [number, number, number] = [0, 1, 2].map((a) => (min[a] + max[a]) / 2) as [number, number, number];
  // The core's vertices sit about its own centre, so it turns in place
  for (let i = 0; i < corePositions.length; i += 3) {
    for (let a = 0; a < 3; a++) corePositions[i + a] -= centre[a];
  }
  const core = new VertexData();
  core.positions = corePositions;
  core.indices = coreIndices;
  if (normals) core.normals = coreNormals;
  if (uvs) core.uvs = coreUvs;
  return { core, centre, rest };
}

/** One split per model geometry: the copies of a model share it, and lose the core from it once. */
const splits = new WeakMap<Geometry, { core: VertexData; centre: [number, number, number] } | null>();
/** One glowing copy of each source material. */
const glowing = new WeakMap<PBRMaterial, PBRMaterial>();
/** The cores of each scene, which one observer turns together. */
const spinning = new WeakMap<Scene, Set<Mesh>>();

function sceneSpin(scene: Scene): Set<Mesh> {
  let cores = spinning.get(scene);
  if (cores) return cores;
  const turning = new Set<Mesh>();
  cores = turning;
  spinning.set(scene, turning);
  const observer = scene.onBeforeRenderObservable.add(() => {
    const angle = ((performance.now() / 1000) * Math.PI * 2) / SPIN_PERIOD;
    for (const core of turning) core.rotation.z = angle;
  });
  scene.onDisposeObservable.addOnce(() => scene.onBeforeRenderObservable.remove(observer));
  return cores;
}

function glowingMaterial(source: PBRMaterial): PBRMaterial {
  let material = glowing.get(source);
  if (material) return material;
  material = source.clone(`${source.name}_core`) as PBRMaterial;
  material.emissiveTexture = source.albedoTexture;
  material.emissiveColor = Color3.White();
  material.emissiveIntensity = CORE_GLOW;
  glowing.set(source, material);
  return material;
}

/**
 * Lift a model's innermost part out as its own mesh, glowing in its own
 * colours and turning in the model's plane: the quad's Q spins inside its
 * ring. Runs once per model geometry; every copy of the model gets its own
 * turning core.
 */
export function addSpinningCore(root: AbstractMesh): void {
  const mesh = root as Mesh;
  const geometry = mesh.geometry;
  const source = mesh.material as PBRMaterial | null;
  if (!geometry || !source || root.isDisposed()) return;
  let split = splits.get(geometry);
  if (split === undefined) {
    const positions = geometry.getVerticesData(VertexBuffer.PositionKind);
    const indices = geometry.getIndices();
    const parts =
      positions && indices
        ? splitCore(
            positions,
            geometry.getVerticesData(VertexBuffer.NormalKind),
            geometry.getVerticesData(VertexBuffer.UVKind),
            indices,
          )
        : null;
    if (parts) geometry.setIndices(parts.rest);
    split = parts ? { core: parts.core, centre: parts.centre } : null;
    splits.set(geometry, split);
  }
  if (!split) return;
  const core = new Mesh(`${root.name}_core`, root.getScene());
  split.core.applyToMesh(core);
  core.material = glowingMaterial(source);
  core.parent = root;
  core.position.set(...split.centre);
  core.metadata = { ...root.metadata };
  const cores = sceneSpin(root.getScene());
  cores.add(core);
  core.onDisposeObservable.addOnce(() => cores.delete(core));
}
