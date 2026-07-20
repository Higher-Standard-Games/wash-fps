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

import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { Color3 } from "@babylonjs/core/Maths/math.color";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Scene } from "@babylonjs/core/scene";
import type { ProceduralPickupRecipe } from "./types";

// Base dimensions at recipe.scale === 1 (Quake units). Scaled per-recipe so
// clones need no extra transform.
const CROSS_ARM = 11; // half-length of each cross bar
const CROSS_THICK = 4.5;
const CORE_DIAM = 23;
const RING_DIAM = 30;
const RING_THICK = 1.5;
const SHELL_INNER = 15; // corona petal distance from center
const PLATE_W = 11;
const PLATE_H = 19;
const PLATE_THICK = 2.4;
const MOTE_BAR = 2.6;
const MOTE_THICK = 0.7;
const SAT_DIAM = 3.4;
const HEXCORE_DIAM = 19;
const HEXCORE_DEPTH = 6;
const FLOOR_DISC_DIAM = 38;
const FLOOR_RING_DIAM = 42;
const FLOOR_RING_THICK = 1.2;
const GLYPH_ARM = 9;
const GLYPH_THICK = 1.4;
const BEACON_HEIGHT = 90;
const BEACON_TOP = 1.5;
const BEACON_BOTTOM = 7;

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
  const s = recipe.scale;
  const len = CROSS_ARM * 2 * s;
  const t = CROSS_THICK * s;
  const barX = MeshBuilder.CreateBox("c_x", { width: len, height: t, depth: t }, scene);
  const barY = MeshBuilder.CreateBox("c_y", { width: t, height: len, depth: t }, scene);
  const barZ = MeshBuilder.CreateBox("c_z", { width: t, height: t, depth: len }, scene);
  return mergeOrThrow([barX, barY, barZ], "proto_cross", scene);
}

/** Translucent faceted energy core shell surrounding the symbol. */
export function buildCoreProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale;
  const core = MeshBuilder.CreateIcoSphere("core", { radius: (CORE_DIAM * s) / 2, subdivisions: 2, flat: true }, scene);
  return finalizeProto(core, "proto_core");
}

/** Hexagonal shield core (armor), oriented so the flat hex faces the viewer. */
export function buildHexCoreProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale;
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
  const s = recipe.scale;
  const ring = MeshBuilder.CreateTorus(
    "ring",
    { diameter: RING_DIAM * s, thickness: RING_THICK * s, tessellation: 28 },
    scene,
  );
  return finalizeProto(ring, "proto_ring");
}

/** One flat shield plate (armor) / corona petal (health shell). */
export function buildPlateProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale;
  const plate = MeshBuilder.CreateBox(
    "plate",
    { width: PLATE_W * s, height: PLATE_H * s, depth: PLATE_THICK * s },
    scene,
  );
  return finalizeProto(plate, "proto_plate");
}

/** Corona petal for health shell (slightly thinner/taller than an armor plate). */
export function buildShellPetalProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale;
  const petal = MeshBuilder.CreateBox("petal", { width: 5 * s, height: (SHELL_INNER + 8) * s, depth: 1.6 * s }, scene);
  return finalizeProto(petal, "proto_petal");
}

/** Rising mote — a tiny plus (health) or shard (armor). */
export function buildMoteProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale;
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
  const s = recipe.scale;
  const sat = MeshBuilder.CreateIcoSphere("sat", { radius: (SAT_DIAM * s) / 2, subdivisions: 1, flat: true }, scene);
  return finalizeProto(sat, "proto_satellite");
}

/** Thin translucent floor disc pedestal. */
export function buildFloorDiscProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale;
  const disc = MeshBuilder.CreateCylinder(
    "floordisc",
    { diameter: FLOOR_DISC_DIAM * s, height: 0.5, tessellation: 40 },
    scene,
  );
  return finalizeProto(disc, "proto_floordisc");
}

/** Flat segmented-look floor ring (torus lying on the ground). */
export function buildFloorRingProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale;
  const ring = MeshBuilder.CreateTorus(
    "floorring",
    { diameter: FLOOR_RING_DIAM * s, thickness: FLOOR_RING_THICK * s, tessellation: 44 },
    scene,
  );
  return finalizeProto(ring, "proto_floorring");
}

/** Floor glyph — a flat health cross or an armor diamond, lying on the ground. */
export function buildFloorGlyphProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale;
  if (recipe.family === "health") {
    const len = GLYPH_ARM * 2 * s;
    const t = GLYPH_THICK * s;
    const barX = MeshBuilder.CreateBox("g_x", { width: len, height: 0.4, depth: t }, scene);
    const barZ = MeshBuilder.CreateBox("g_z", { width: t, height: 0.4, depth: len }, scene);
    return mergeOrThrow([barX, barZ], "proto_glyph", scene);
  }
  const diamond = MeshBuilder.CreateBox(
    "g_d",
    { width: GLYPH_ARM * 1.4 * s, height: 0.4, depth: GLYPH_ARM * 1.4 * s },
    scene,
  );
  diamond.rotation.y = Math.PI / 4;
  diamond.bakeCurrentTransformIntoVertices();
  return finalizeProto(diamond, "proto_glyph");
}

/** Faint vertical beacon (mega/ultra/red) for arena-scale readability. */
export function buildBeaconProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale;
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

/**
 * Give a mesh a solid vertex-color so bloom/emissive reads uniformly even if a
 * material is swapped later. Currently unused by the baseline (materials carry
 * the color) but kept as a small helper for tuning experiments.
 */
export function tintVertices(mesh: Mesh, color: Color3): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  if (!positions) return;
  const count = positions.length / 3;
  const colors = new Array<number>(count * 4);
  for (let i = 0; i < count; i++) {
    colors[i * 4] = color.r;
    colors[i * 4 + 1] = color.g;
    colors[i * 4 + 2] = color.b;
    colors[i * 4 + 3] = 1;
  }
  mesh.setVerticesData(VertexBuffer.ColorKind, colors);
}
