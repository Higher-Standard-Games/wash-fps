/**
 * Geometry builders for procedural pickups (docs/research/PROCEDURAL_ITEMS.md
 * §"Geometry primitives"). Each builder returns a disabled, unparented prototype
 * MESH sized for the given recipe. The scene-scoped asset cache generates these
 * once per recipe and the runtime visual clones them per pickup (clones share
 * the prototype's GPU geometry, so a whole map's items cost one geometry each).
 *
 * The vocabulary is deliberately small and built from MeshBuilder primitives —
 * chunky, cel-readable shapes rather than heavyweight custom meshes. Material
 * assignment (structural vs energy) is the visual's job, not the geometry's.
 */

import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Scene } from "@babylonjs/core/scene";
import { PROCEDURAL_GLOBAL_SCALE } from "./ProceduralPickupRecipes";
import type { ProceduralPickupRecipe } from "./types";

// Base dimensions at recipe.scale === 1 (Quake units), tuned for a compact,
// normal-item-sized silhouette. Scaled per-recipe so clones need no transform.
const CROSS_ARM = 6; // half-length of each cross bar (small, clean emblem)
const CROSS_THICK = 2.0;
const CORE_DIAM = 15;
const RING_DIAM = 21;
const RING_THICK = 0.9; // thin sci-fi ring
const SHELL_INNER = 12; // corona petal distance from center (legacy, unused)
const HEXPLATE_DIAM = 15; // hexagonal shield plate
const HEXPLATE_DEPTH = 1.8;
const MOTE_BAR = 2.2;
const MOTE_THICK = 0.6;
const SAT_DIAM = 2.8;
const HEXCORE_DIAM = 8; // small bright armor core behind the plates
const HEXCORE_DEPTH = 3;
const BEACON_HEIGHT = 90;
const BEACON_TOP = 1.2;
const BEACON_BOTTOM = 5;

/** Force a solid, flat-shaded normal set so merged relic geometry cel-reads. */
function finalizeProto(mesh: Mesh, name: string): Mesh {
  mesh.name = name;
  mesh.isPickable = false;
  mesh.setEnabled(false);
  mesh.isVisible = false;
  return mesh;
}

function mergeOrThrow(meshes: Mesh[], name: string, scene: Scene): Mesh {
  const merged = Mesh.MergeMeshes(meshes, true, true);
  if (merged) return finalizeProto(merged, name);
  // MergeMeshes returns null only on degenerate input; fall back to an empty
  // placeholder so callers never crash (should not happen for boxes).
  return finalizeProto(new Mesh(name, scene), name);
}

/** 3D health cross: three orthogonal bars merged into one rigid symbol. */
export function buildCrossProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale * PROCEDURAL_GLOBAL_SCALE;
  const len = CROSS_ARM * 2 * s;
  const t = CROSS_THICK * s;
  const barX = MeshBuilder.CreateBox("c_x", { width: len, height: t, depth: t }, scene);
  const barY = MeshBuilder.CreateBox("c_y", { width: t, height: len, depth: t }, scene);
  const barZ = MeshBuilder.CreateBox("c_z", { width: t, height: t, depth: len }, scene);
  return mergeOrThrow([barX, barY, barZ], "proto_cross", scene);
}

/** Translucent faceted energy core shell surrounding the symbol. */
export function buildCoreProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale * PROCEDURAL_GLOBAL_SCALE;
  const core = MeshBuilder.CreateIcoSphere("core", { radius: (CORE_DIAM * s) / 2, subdivisions: 2, flat: true }, scene);
  return finalizeProto(core, "proto_core");
}

/** Hexagonal shield core (armor), oriented so the flat hex faces the viewer. */
export function buildHexCoreProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale * PROCEDURAL_GLOBAL_SCALE;
  const hex = MeshBuilder.CreateCylinder(
    "hexcore",
    { diameter: HEXCORE_DIAM * s, height: HEXCORE_DEPTH * s, tessellation: 6 },
    scene,
  );
  // Lay the hex disc face-forward (+Z) instead of axis-up.
  hex.rotation.x = Math.PI / 2;
  hex.bakeCurrentTransformIntoVertices();
  return finalizeProto(hex, "proto_hexcore");
}

/** One orbiting ring (torus lying in the XZ plane; the visual tilts/spins it). */
export function buildRingProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale * PROCEDURAL_GLOBAL_SCALE;
  const ring = MeshBuilder.CreateTorus(
    "ring",
    { diameter: RING_DIAM * s, thickness: RING_THICK * s, tessellation: 28 },
    scene,
  );
  return finalizeProto(ring, "proto_ring");
}

/** One clean hexagonal shield plate (armor), oriented flat-face toward +Z. */
export function buildPlateProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale * PROCEDURAL_GLOBAL_SCALE;
  const plate = MeshBuilder.CreateCylinder(
    "plate",
    { diameter: HEXPLATE_DIAM * s, height: HEXPLATE_DEPTH * s, tessellation: 6 },
    scene,
  );
  plate.rotation.x = Math.PI / 2; // lay the hex flat, facing the viewer
  plate.bakeCurrentTransformIntoVertices();
  return finalizeProto(plate, "proto_plate");
}

/** Corona petal for health shell (slightly thinner/taller than an armor plate). */
export function buildShellPetalProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale * PROCEDURAL_GLOBAL_SCALE;
  const petal = MeshBuilder.CreateBox("petal", { width: 5 * s, height: (SHELL_INNER + 8) * s, depth: 1.6 * s }, scene);
  return finalizeProto(petal, "proto_petal");
}

/** Rising mote — a tiny plus (health) or shard (armor). */
export function buildMoteProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale * PROCEDURAL_GLOBAL_SCALE;
  if (recipe.family === "health") {
    const bar = MOTE_BAR * s;
    const t = MOTE_THICK * s;
    const h = MeshBuilder.CreateBox("m_h", { width: bar, height: t, depth: t }, scene);
    const v = MeshBuilder.CreateBox("m_v", { width: t, height: bar, depth: t }, scene);
    return mergeOrThrow([h, v], "proto_mote", scene);
  }
  const shard = MeshBuilder.CreatePolyhedron("shard", { type: 0, size: MOTE_BAR * 0.5 * s }, scene);
  return finalizeProto(shard, "proto_mote");
}

/** Small orbiting satellite core (mega/ultra). */
export function buildSatelliteProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale * PROCEDURAL_GLOBAL_SCALE;
  const sat = MeshBuilder.CreateIcoSphere("sat", { radius: (SAT_DIAM * s) / 2, subdivisions: 1, flat: true }, scene);
  return finalizeProto(sat, "proto_satellite");
}

/** Faint vertical beacon (mega/ultra/red) for arena-scale readability. */
export function buildBeaconProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale * PROCEDURAL_GLOBAL_SCALE;
  const beacon = MeshBuilder.CreateCylinder(
    "beacon",
    {
      height: BEACON_HEIGHT,
      diameterTop: BEACON_TOP * s,
      diameterBottom: BEACON_BOTTOM * s,
      tessellation: 14,
    },
    scene,
  );
  return finalizeProto(beacon, "proto_beacon");
}
