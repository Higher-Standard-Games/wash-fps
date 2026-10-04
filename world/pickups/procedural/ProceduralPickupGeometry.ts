/**
 * Geometry builders for procedural pickups (docs/research/PROCEDURAL_ITEMS.md
 * §"Geometry primitives"). Each builder returns a disabled, unparented prototype
 * MESH sized for the given recipe. The scene-scoped asset cache generates these
 * once per recipe and the runtime visual clones them per pickup (clones share
 * the prototype's GPU geometry, so a whole map's items cost one geometry each).
 *
 * Current vocabulary (lit solid objects, no edge outlines):
 *  - Health: a SMOOTH sphere shell (smooth normals so the fresnel rim grades
 *    cleanly, no facet banding) around a chunky cross emblem, whose up/down
 *    faces are capped by a separate mesh so they can take their own colour.
 *  - Armor: broad chest, shoulder, and waist plates over a dark backer. The
 *    shard is a smaller broken plate.
 *  - Ammo: chamfered chassis, colored inserts, and type-specific geometric marks.
 *  - Quad: dark octagonal badge with a luminous Q on both faces.
 * Material assignment (structural vs energy) is the visual's job, not the
 * geometry's.
 */

import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Scene } from "@babylonjs/core/scene";
import { PROCEDURAL_GLOBAL_SCALE } from "./ProceduralPickupRecipes";
import type { ProceduralPickupRecipe } from "./types";

// Base dimensions at recipe.scale === 1 (Quake units), tuned for a compact,
// normal-item-sized silhouette. Scaled per-recipe so clones need no transform.
const CROSS_ARM = 6; // half-length of each cross bar (small, clean emblem)
const CROSS_THICK = 2.0;
/** How far the black top/bottom caps sit proud of the bar faces (z-fight guard). */
const CROSS_CAP_LIFT = 0.06;
const CORE_DIAM = 15;
const RING_DIAM = 21;
const RING_THICK = 0.9; // thin sci-fi ring
const SAT_DIAM = 2.8;
// Armor is a compact plate carrier with one broad shoulder/chest silhouette.
const ARMOR_HEIGHT = 20;
const ARMOR_WIDTH = 19;
const SHARD_SIZE_RATIO = 0.9;
// Ammo: a chunky crate (see buildAmmoCrateProto).
const CRATE_W = 15; // wider than deep — reads as a box, not a cube
const CRATE_H = 11;
const CRATE_D = 11;
/** Icon decal size, as a fraction of the face it sits on. */
const CRATE_ICON_FILL = 0.62;
// Quad uses a dark octagonal badge and a luminous Q on both faces.
const QUAD_BADGE_DIAM = 20;
const QUAD_MARK_DIAM = 12;
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
 * Caps for the cross's horizontal (±Y) surfaces, in the tier colour.
 *
 * The emblem body is the brighter accent colour and these faces sit a shade
 * under it, which keeps the arms legible edge-on and stops the cross flaring
 * into one bright blob when it spins past the camera. Thin plates laid just
 * proud of each bar's top and
 * bottom face — the vertical bar deliberately passes through the horizontal
 * bars' caps, which reads as an inlay from above.
 */
export function buildCrossCapsProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale * PROCEDURAL_GLOBAL_SCALE;
  const len = CROSS_ARM * 2 * s;
  const t = CROSS_THICK * s;
  const lift = CROSS_CAP_LIFT * s;
  const plate = t * 0.06; // wafer-thin: it is a surface, not a slab

  const caps: Mesh[] = [];
  for (const sign of [1, -1]) {
    // Horizontal bars: full-length top/bottom faces.
    const capX = MeshBuilder.CreateBox("cap_x", { width: len, height: plate, depth: t }, scene);
    capX.position.y = sign * (t / 2 + lift);
    caps.push(capX);
    const capZ = MeshBuilder.CreateBox("cap_z", { width: t, height: plate, depth: len }, scene);
    capZ.position.y = sign * (t / 2 + lift);
    caps.push(capZ);
    // Vertical bar: the small end cap at each tip.
    const capY = MeshBuilder.CreateBox("cap_y", { width: t, height: plate, depth: t }, scene);
    capY.position.y = sign * (len / 2 + lift);
    caps.push(capY);
  }
  return mergeOrThrow(caps, "proto_cross_caps", scene);
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

/** Place a part, then bake the transform in so the merge keeps it. */
function bakePart(mesh: Mesh): Mesh {
  mesh.bakeCurrentTransformIntoVertices();
  return mesh;
}

/** Extrude a star-shaped XY outline into a lit, low-poly plate. */
function extrudedPlate(scene: Scene, name: string, outline: readonly [number, number][], depth: number, z = 0): Mesh {
  const mesh = new Mesh(name, scene);
  const count = outline.length;
  const front = z + depth / 2;
  const back = z - depth / 2;
  const positions: number[] = [0, 0, front, 0, 0, back];
  for (const [x, y] of outline) positions.push(x, y, front);
  for (const [x, y] of outline) positions.push(x, y, back);

  const area = outline.reduce((sum, [x, y], i) => {
    const [nx, ny] = outline[(i + 1) % count];
    return sum + x * ny - nx * y;
  }, 0);
  const ccw = area > 0;
  const indices: number[] = [];
  for (let i = 0; i < count; i++) {
    const next = (i + 1) % count;
    const fi = 2 + i;
    const fn = 2 + next;
    const bi = 2 + count + i;
    const bn = 2 + count + next;
    if (ccw) indices.push(0, fi, fn, 1, bn, bi, fi, bi, bn, fi, bn, fn);
    else indices.push(0, fn, fi, 1, bi, bn, fi, bn, bi, fi, fn, bn);
  }
  const normals = new Array<number>(positions.length).fill(0);
  VertexData.ComputeNormals(positions, indices, normals);
  const uvs: number[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    uvs.push(positions[i] / 32 + 0.5, positions[i + 1] / 32 + 0.5);
  }
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  data.normals = normals;
  data.uvs = uvs;
  data.applyToMesh(mesh);
  mesh.convertToFlatShadedMesh();
  return mesh;
}

function scaledOutline(width: number, height: number, points: readonly [number, number][]): [number, number][] {
  return points.map(([x, y]) => [x * width, y * height]);
}

/** Dark continuous backer keeps the armor readable between separate plates. */
export function buildArmorFrameProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale * PROCEDURAL_GLOBAL_SCALE * (recipe.kind === "shard" ? SHARD_SIZE_RATIO : 1);
  const w = ARMOR_WIDTH * s;
  const h = ARMOR_HEIGHT * s;
  const outline: [number, number][] =
    recipe.kind === "shard"
      ? [
          [-0.42, 0.22],
          [-0.12, 0.38],
          [0.31, 0.19],
          [0.39, -0.13],
          [0.06, -0.37],
          [-0.3, -0.24],
          [-0.48, 0.02],
        ]
      : [
          [-0.29, 0.46],
          [-0.46, 0.3],
          [-0.42, 0.02],
          [-0.29, -0.1],
          [-0.24, -0.47],
          [0.24, -0.47],
          [0.29, -0.1],
          [0.42, 0.02],
          [0.46, 0.3],
          [0.29, 0.46],
        ];
  return finalizeProto(extrudedPlate(scene, "armor_frame", scaledOutline(w, h, outline), 5 * s), "proto_armor_frame");
}

/** A few large plates reveal a chest, shoulders and waist at arena distance. */
export function buildArmorProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale * PROCEDURAL_GLOBAL_SCALE * (recipe.kind === "shard" ? SHARD_SIZE_RATIO : 1);
  const w = ARMOR_WIDTH * s;
  const h = ARMOR_HEIGHT * s;
  const parts: Mesh[] = [];
  const frontZ = 3.1 * s;
  const panels: [number, number][][] =
    recipe.kind === "shard"
      ? [
          [
            [-0.35, 0.17],
            [-0.09, 0.32],
            [0.26, 0.15],
            [0.32, -0.1],
            [0.04, -0.3],
            [-0.24, -0.19],
            [-0.4, 0.02],
          ],
        ]
      : [
          [
            [-0.35, 0.22],
            [-0.18, 0.36],
            [0, 0.25],
            [0.18, 0.36],
            [0.35, 0.22],
            [0.29, -0.09],
            [0, -0.24],
            [-0.29, -0.09],
          ],
          [
            [-0.22, -0.18],
            [0.22, -0.18],
            [0.19, -0.39],
            [0, -0.48],
            [-0.19, -0.39],
          ],
          [
            [-0.48, 0.27],
            [-0.31, 0.4],
            [-0.29, 0.1],
            [-0.42, 0.04],
          ],
          [
            [0.31, 0.4],
            [0.48, 0.27],
            [0.42, 0.04],
            [0.29, 0.1],
          ],
        ];
  for (const points of panels) {
    const outline = scaledOutline(w, h, points);
    parts.push(extrudedPlate(scene, "armor_plate_front", outline, 1.35 * s, frontZ));
    parts.push(extrudedPlate(scene, "armor_plate_back", outline, 1.35 * s, -frontZ));
  }
  return mergeOrThrow(parts, "proto_armor", scene);
}

/** Dark chamfered chassis; color comes from separate inset panels. */
export function buildAmmoCrateProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale * PROCEDURAL_GLOBAL_SCALE;
  const w = CRATE_W * s;
  const h = CRATE_H * s;
  const d = CRATE_D * s;
  const outline: [number, number][] = [
    [-0.42, 0.5],
    [-0.5, 0.34],
    [-0.5, -0.34],
    [-0.42, -0.5],
    [0.42, -0.5],
    [0.5, -0.34],
    [0.5, 0.34],
    [0.42, 0.5],
  ];
  const body = extrudedPlate(scene, "ammo_chassis", scaledOutline(w, h, outline), d);
  const handle = MeshBuilder.CreateBox(
    "ammo_handle",
    {
      width: w * 0.44,
      height: h * 0.12,
      depth: d * 0.52,
    },
    scene,
  );
  handle.position.y = h * 0.55;
  return mergeOrThrow([body, bakePart(handle)], "proto_ammo_crate", scene);
}

/** Saturated front/back armor inserts and side rails stay visible without PK3 art. */
export function buildAmmoPanelProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale * PROCEDURAL_GLOBAL_SCALE;
  const w = CRATE_W * s;
  const h = CRATE_H * s;
  const d = CRATE_D * s;
  const outline: [number, number][] = [
    [-0.35, 0.36],
    [-0.41, 0.24],
    [-0.41, -0.24],
    [-0.35, -0.36],
    [0.35, -0.36],
    [0.41, -0.24],
    [0.41, 0.24],
    [0.35, 0.36],
  ];
  const parts: Mesh[] = [];
  for (const sign of [-1, 1]) {
    parts.push(extrudedPlate(scene, "ammo_panel", scaledOutline(w, h, outline), 0.7 * s, sign * (d / 2 + 0.46 * s)));
    const side = MeshBuilder.CreateBox(
      "ammo_side_rail",
      {
        width: 0.85 * s,
        height: h * 0.56,
        depth: d * 0.58,
      },
      scene,
    );
    side.position.x = sign * (w / 2 + 0.18 * s);
    parts.push(bakePart(side));
  }
  return mergeOrThrow(parts, "proto_ammo_panel", scene);
}

/** Geometric ammo glyphs make types legible even if an optional icon is missing. */
export function buildAmmoMarkProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale * PROCEDURAL_GLOBAL_SCALE;
  const w = CRATE_W * s;
  const h = CRATE_H * s;
  const d = CRATE_D * s;
  const box = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
    [x0, y0],
    [x0, y1],
    [x1, y1],
    [x1, y0],
  ];
  const marks: [number, number][][] = [];
  switch (recipe.kind) {
    case "bullets":
      for (const x of [-0.17, 0, 0.17]) marks.push(box(x - 0.045, -0.22, x + 0.045, 0.22));
      break;
    case "shells":
      for (const x of [-0.11, 0.11]) marks.push(box(x - 0.075, -0.22, x + 0.075, 0.22));
      break;
    case "grenades":
      marks.push([
        [-0.2, 0.08],
        [-0.14, 0.23],
        [0.14, 0.23],
        [0.2, 0.08],
        [0.13, -0.2],
        [-0.13, -0.2],
      ]);
      marks.push(box(-0.04, 0.22, 0.04, 0.32));
      break;
    case "rockets":
      marks.push([
        [-0.08, -0.13],
        [-0.08, 0.13],
        [0, 0.31],
        [0.08, 0.13],
        [0.08, -0.13],
      ]);
      marks.push([
        [-0.08, -0.04],
        [-0.24, -0.22],
        [-0.08, -0.18],
      ]);
      marks.push([
        [0.08, -0.04],
        [0.24, -0.22],
        [0.08, -0.18],
      ]);
      marks.push([
        [-0.05, -0.15],
        [0, -0.31],
        [0.05, -0.15],
      ]);
      break;
    case "cells":
      marks.push([
        [0, 0.3],
        [0.25, 0],
        [0, -0.3],
        [-0.25, 0],
      ]);
      break;
    case "lasers":
      marks.push([
        [-0.02, 0.31],
        [0.2, 0.31],
        [0.035, 0.02],
        [0.19, 0.02],
        [-0.2, -0.31],
        [-0.04, -0.04],
        [-0.19, -0.04],
      ]);
      break;
    case "bolts":
      marks.push([
        [-0.26, 0.2],
        [-0.19, 0.28],
        [0.26, -0.2],
        [0.19, -0.28],
      ]);
      marks.push([
        [-0.26, -0.2],
        [-0.19, -0.28],
        [0.26, 0.2],
        [0.19, 0.28],
      ]);
      break;
    default:
      marks.push([
        [0, 0.31],
        [0.08, 0.08],
        [0.28, 0],
        [0.08, -0.08],
        [0, -0.31],
        [-0.08, -0.08],
        [-0.28, 0],
        [-0.08, 0.08],
      ]);
  }
  const parts: Mesh[] = [];
  for (const sign of [-1, 1]) {
    for (const mark of marks) {
      parts.push(extrudedPlate(scene, "ammo_mark", scaledOutline(w, h, mark), 0.45 * s, sign * (d / 2 + 1.1 * s)));
    }
  }
  return mergeOrThrow(parts, "proto_ammo_mark", scene);
}

/**
 * Optional ammo texture decals on the narrow sides, merged into one mesh.
 *
 * Generated geometry owns the front/back symbols; these texture decals add
 * detail on the sides when the optional PK3 art is available.
 */
export function buildAmmoIconProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale * PROCEDURAL_GLOBAL_SCALE;
  const w = CRATE_W * s;
  const h = CRATE_H * s;
  const size = Math.min(w, h) * CRATE_ICON_FILL;
  const lift = 0.7 * s;

  const quads: Mesh[] = [];
  // `sideOrientation` is irrelevant because the decal material disables
  // back-face culling.
  const faces: Array<{ pos: [number, number, number]; yaw: number }> = [
    { pos: [w / 2 + lift, 0, 0], yaw: Math.PI / 2 },
    { pos: [-(w / 2 + lift), 0, 0], yaw: -Math.PI / 2 },
  ];
  for (const face of faces) {
    const quad = MeshBuilder.CreatePlane("crate_icon", { width: size, height: size }, scene);
    quad.position.set(face.pos[0], face.pos[1], face.pos[2]);
    quad.rotation.y = face.yaw;
    quads.push(bakePart(quad));
  }
  return mergeOrThrow(quads, "proto_ammo_icon", scene);
}

/** Dark octagonal medallion: a stable silhouette with no tall cage or beacon. */
export function buildPowerupCoreProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale * PROCEDURAL_GLOBAL_SCALE;
  const badge = MeshBuilder.CreateCylinder(
    "quad_badge",
    {
      height: 3.5 * s,
      diameter: QUAD_BADGE_DIAM * s,
      tessellation: 8,
    },
    scene,
  );
  badge.rotation.x = Math.PI / 2;
  badge.rotation.z = Math.PI / 8;
  bakePart(badge);
  return finalizeProto(badge, "proto_powerup_core");
}

/** A luminous Q and four small corner sparks make Quad legible at a glance. */
export function buildPowerupMarkProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale * PROCEDURAL_GLOBAL_SCALE;
  const parts: Mesh[] = [];
  for (const face of [-1, 1]) {
    const z = face * 2.3 * s;
    const ring = MeshBuilder.CreateTorus(
      "quad_q_ring",
      {
        diameter: QUAD_MARK_DIAM * s,
        thickness: 1.65 * s,
        tessellation: 32,
      },
      scene,
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.z = z;
    parts.push(bakePart(ring));

    const tail = MeshBuilder.CreateBox(
      "quad_q_tail",
      {
        width: 1.8 * s,
        height: 5.2 * s,
        depth: 1.2 * s,
      },
      scene,
    );
    tail.position.set(4.2 * s, -4.8 * s, z);
    tail.rotation.z = -0.7;
    parts.push(bakePart(tail));

    for (const x of [-1, 1]) {
      for (const y of [-1, 1]) {
        const spark = MeshBuilder.CreateBox(
          "quad_corner",
          {
            width: 1.4 * s,
            height: 1.4 * s,
            depth: 1.1 * s,
          },
          scene,
        );
        spark.position.set(x * 6.9 * s, y * 6.9 * s, z);
        spark.rotation.z = Math.PI / 4;
        parts.push(bakePart(spark));
      }
    }
  }
  return mergeOrThrow(parts, "proto_powerup_mark", scene);
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
