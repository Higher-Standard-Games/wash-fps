/**
 * Geometry builders for procedural pickups (docs/research/PROCEDURAL_ITEMS.md
 * §"Geometry primitives"). Each builder returns a disabled, unparented prototype
 * MESH sized for the given recipe. The scene-scoped asset cache generates these
 * once per recipe and the runtime visual clones them per pickup (clones share
 * the prototype's GPU geometry, so a whole map's items cost one geometry each).
 *
 * v4 vocabulary (fresnel + edge-lit direction):
 *  - Health: a SMOOTH sphere shell (smooth normals so the fresnel rim grades
 *    cleanly, no facet banding) around a chunky cross emblem that gets glowing
 *    edge lines at assembly time.
 *  - Armor: ONE solid sculpted shield — a beveled extruded hex badge (body +
 *    smaller front cap merged) whose hex seams light up via edge rendering —
 *    plus thin chevron bars inlaid on its face (count = tier). The shard tier
 *    is a broken triangular fragment of the same language.
 * Material assignment (structural vs energy) is the visual's job, not the
 * geometry's.
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
const SAT_DIAM = 2.8;
const SHIELD_DIAM = 16; // solid hex badge
const SHIELD_DEPTH = 4;
const SHIELD_CAP_RATIO = 0.72; // front cap = beveled face
const CHEVRON_W = 7;
const CHEVRON_H = 1.6;
const CHEVRON_DEPTH = 0.9;
const BEACON_HEIGHT = 90;
const BEACON_TOP = 1.2;
const BEACON_BOTTOM = 5;

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

/**
 * Smooth energy shell around the health emblem. Smooth (non-flat) normals are
 * required for the fresnel rim to grade cleanly — a flat icosphere shows facet
 * banding at the silhouette.
 */
export function buildCoreProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale * PROCEDURAL_GLOBAL_SCALE;
  const core = MeshBuilder.CreateSphere("core", { diameter: CORE_DIAM * s, segments: 24 }, scene);
  return finalizeProto(core, "proto_core");
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

/**
 * Solid sculpted shield (armor): an extruded hex body with a smaller hex cap
 * merged onto its front face for a beveled-badge silhouette that reads from
 * every angle (including edge-on). Face points +Z; hex seams are lit by edge
 * rendering at assembly time. The shard tier is a broken triangular fragment
 * built from the same language (tessellation 3).
 */
export function buildShieldProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale * PROCEDURAL_GLOBAL_SCALE;
  const sides = recipe.kind === "shard" ? 3 : 6;
  const body = MeshBuilder.CreateCylinder(
    "sh_body",
    { diameter: SHIELD_DIAM * s, height: SHIELD_DEPTH * s, tessellation: sides },
    scene,
  );
  const cap = MeshBuilder.CreateCylinder(
    "sh_cap",
    { diameter: SHIELD_DIAM * SHIELD_CAP_RATIO * s, height: SHIELD_DEPTH * 0.5 * s, tessellation: sides },
    scene,
  );
  cap.position.y = SHIELD_DEPTH * 0.6 * s;
  const merged = mergeOrThrow([body, cap], "proto_shield", scene);
  // Face forward (+Z): the cylinder axis becomes the depth axis.
  merged.rotation.x = Math.PI / 2;
  merged.bakeCurrentTransformIntoVertices();
  return merged;
}

/** One glowing chevron bar inlaid on the shield face (count = tier). */
export function buildChevronProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale * PROCEDURAL_GLOBAL_SCALE;
  const bar = MeshBuilder.CreateBox(
    "chevron",
    { width: CHEVRON_W * s, height: CHEVRON_H * s, depth: CHEVRON_DEPTH * s },
    scene,
  );
  return finalizeProto(bar, "proto_chevron");
}

/** Vertical spacing between chevron bars, matching the chevron proto scale. */
export function chevronSpacing(recipe: ProceduralPickupRecipe): number {
  return (CHEVRON_H + 1.0) * recipe.scale * PROCEDURAL_GLOBAL_SCALE;
}

/** Z offset that places a chevron proud of the shield's front cap. */
export function chevronFaceOffset(recipe: ProceduralPickupRecipe): number {
  return (SHIELD_DEPTH * 0.85 + CHEVRON_DEPTH * 0.5) * recipe.scale * PROCEDURAL_GLOBAL_SCALE;
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
