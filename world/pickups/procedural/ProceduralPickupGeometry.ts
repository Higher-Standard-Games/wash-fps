/**
 * Geometry builders for procedural pickups (docs/research/PROCEDURAL_ITEMS.md
 * §"Geometry primitives"). Each builder returns a disabled, unparented prototype
 * MESH sized for the given recipe. The scene-scoped asset cache generates these
 * once per recipe and the runtime visual clones them per pickup (clones share
 * the prototype's GPU geometry, so a whole map's items cost one geometry each).
 *
 * v6 vocabulary (lit solid objects, no edge outlines):
 *  - Health: a SMOOTH sphere shell (smooth normals so the fresnel rim grades
 *    cleanly, no facet banding) around a chunky cross emblem, whose up/down
 *    faces are capped by a separate mesh so they can take their own colour.
 *  - Armor: banded plates wrapped around an elliptical torso — a stack of rings
 *    of small blocks, so the silhouette reads round while every surface stays a
 *    flat facet. The shard tier is the same construction, smaller.
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
/** How far the black top/bottom caps sit proud of the bar faces (z-fight guard). */
const CROSS_CAP_LIFT = 0.06;
const CORE_DIAM = 15;
const RING_DIAM = 21;
const RING_THICK = 0.9; // thin sci-fi ring
const SAT_DIAM = 2.8;
// Armor: banded plates wrapped around a torso (see buildArmorProto).
const ARMOR_HEIGHT = 20;
const ARMOR_WIDTH = 19;
/** Plate thickness, as a fraction of width. */
const ARMOR_PLATE_DEPTH = 0.075;
/** Per-plate irregularity. Small: bigger values open gaps between neighbours. */
const ARMOR_SCULPT = 0.022;
/** Neighbouring plates in a band overlap by this much so no seams show through. */
const ARMOR_PLATE_OVERLAP = 1.3;
/** Vertical overlap between bands, so the stack has no gaps between rows. */
const ARMOR_BAND_OVERLAP = 1.35;
/** Solid core sits this far inside the plate ring — plates stay proud of it. */
const ARMOR_CORE_INSET = 0.82;
const SHARD_SIZE_RATIO = 0.62;
// Ammo: a chunky crate (see buildAmmoCrateProto).
const CRATE_W = 15; // wider than deep — reads as a box, not a cube
const CRATE_H = 11;
const CRATE_D = 11;
/** Corner posts / rim straps, as a fraction of the crate's smallest dimension. */
const CRATE_FRAME = 0.16;
/** How far the frame stands proud of the body. */
const CRATE_FRAME_PROUD = 0.5;
/** Lid slab height, as a fraction of crate height. */
const CRATE_LID_H = 0.16;
/** Icon decal size, as a fraction of the face it sits on. */
const CRATE_ICON_FILL = 0.62;
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
 * Matte black caps for the cross's horizontal (±Y) surfaces.
 *
 * The emblem body is solid bright colour so it reads as a symbol rather than the
 * dark silhouette it used to be; blacking out only the up/down faces keeps the
 * arms legible edge-on and stops the cross flaring into a bright blob when it
 * spins past the camera. Thin plates laid just proud of each bar's top and
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

/** Deterministic 0..1 hash — same sculpt every run, so the pack looks stable. */
function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Place a part, then bake the transform in so the merge keeps it. */
function bakePart(mesh: Mesh): Mesh {
  mesh.bakeCurrentTransformIntoVertices();
  return mesh;
}

/** One band of armor: a ring of plates at a height, on an elliptical torso section. */
interface ArmorBand {
  /** Centre height, as a fraction of total height (0 = middle). */
  y: number;
  /** Half-width / half-depth of the ellipse, as fractions of total width. */
  rx: number;
  rz: number;
  /** Plate height, as a fraction of total height. */
  h: number;
  /** How far around the torso this band wraps, in radians (centred on the front). */
  span: number;
  /** Plates in the band. More plates = rounder silhouette, same blocky language. */
  count: number;
  /** Outward/upward cant of each plate (radians). */
  tilt: number;
}

/**
 * Torso bands, top to bottom. Widths bulge at the chest and draw in at the
 * collar and waist, which is what makes the stack read as a body rather than a
 * barrel — each band is a ring of flat blocks, so the roundness comes from plate
 * COUNT following the curve, not from smooth geometry.
 */
const ARMOR_BANDS: ArmorBand[] = [
  { y: 0.44, rx: 0.4, rz: 0.28, h: 0.13, span: 2.5, count: 7, tilt: -0.3 },
  { y: 0.26, rx: 0.5, rz: 0.35, h: 0.2, span: 3.0, count: 10, tilt: -0.12 },
  { y: 0.04, rx: 0.52, rz: 0.36, h: 0.24, span: 3.1, count: 11, tilt: 0.0 },
  { y: -0.2, rx: 0.47, rz: 0.32, h: 0.22, span: 2.9, count: 9, tilt: 0.1 },
  { y: -0.42, rx: 0.4, rz: 0.27, h: 0.2, span: 2.6, count: 7, tilt: 0.22 },
];

/**
 * Armor pickup: banded plates wrapped around a torso.
 *
 * Two earlier passes failed in instructive ways. A single tapered cylinder arc
 * read as a bucket. Bolting big boxes onto a flat chest plate read as detached
 * cubes floating next to a card — the parts never became one object.
 *
 * A third pass built bands of plates with nothing behind them, which left
 * see-through holes between the blocks — a loose pile rather than one object.
 * So there is now a solid elliptical CORE just inside the plate ring, and the
 * plates are relief on top of it. Gaps show the body, never the background.
 *
 * On top of that it builds the armor the way real segmented plate works: BANDS,
 * each a ring of small blocks laid around an elliptical torso section and turned
 * to face outward. Roundness comes from plate count following the curve rather
 * than from smooth geometry, so the silhouette reads as a rounded volume while
 * every surface stays a flat block. Bands bulge at the chest and draw in at
 * collar and waist; each plate gets a small deterministic wobble in reach, size
 * and roll so the result looks assembled rather than lathed. Shoulder caps are
 * the outermost plates of the top bands, scaled up and canted — part of the
 * band, so they can never drift away from the body.
 *
 * Tier is carried by COLOUR and size alone (green / yellow / red are one
 * silhouette in Warsow), which is why there are no chevron bars to count. The
 * shard tier is the same construction, smaller and with the lower bands dropped.
 */
export function buildArmorProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale * PROCEDURAL_GLOBAL_SCALE;
  const fragment = recipe.kind === "shard";
  const sizeRatio = fragment ? SHARD_SIZE_RATIO : 1;
  const height = ARMOR_HEIGHT * sizeRatio * s;
  const width = ARMOR_WIDTH * sizeRatio * s;
  const thickness = width * ARMOR_PLATE_DEPTH;

  let seed = 0;
  for (let i = 0; i < recipe.id.length; i++) seed += recipe.id.charCodeAt(i);

  // A shard is a broken piece: the chest bands only, no collar or skirt.
  const bands = fragment ? ARMOR_BANDS.slice(1, 3) : ARMOR_BANDS;
  const parts: Mesh[] = [];

  // ── Solid core, first.
  // The bands alone left see-through holes between plates, which read as a loose
  // pile of blocks rather than one armored object. A closed elliptical torso
  // sitting just inside the plate ring fills every gap, so the plates become
  // RELIEF on a solid body instead of the body itself. Tessellated enough to
  // look round, flat-shaded so it still facets.
  {
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxRx = 0;
    let maxRz = 0;
    for (const b of bands) {
      minY = Math.min(minY, (b.y - b.h / 2) * height);
      maxY = Math.max(maxY, (b.y + b.h / 2) * height);
      maxRx = Math.max(maxRx, b.rx * width);
      maxRz = Math.max(maxRz, b.rz * width);
    }
    const core = MeshBuilder.CreateCylinder(
      "armor_core",
      {
        height: maxY - minY,
        diameterTop: 2 * maxRx * ARMOR_CORE_INSET * 0.9,
        diameterBottom: 2 * maxRx * ARMOR_CORE_INSET * 0.86,
        tessellation: 16,
      },
      scene,
    );
    core.position.y = (minY + maxY) / 2;
    core.scaling.z = maxRz / maxRx; // circular section → elliptical torso
    parts.push(bakePart(core));
  }

  bands.forEach((band, bandIndex) => {
    const rx = band.rx * width;
    const rz = band.rz * width;
    const plateH = band.h * height;
    const step = band.span / band.count;

    for (let i = 0; i < band.count; i++) {
      // Angle measured from the front (+Z), sweeping symmetrically to both sides.
      const angle = -band.span / 2 + (i + 0.5) * step;
      const n = bandIndex * 31 + i + seed;
      const jitter = (hash01(n) - 0.5) * 2 * ARMOR_SCULPT;
      const reach = 1 + jitter;

      // Chord length across this segment, so neighbours meet with a slight overlap.
      const radiusHere = Math.hypot(rx * Math.sin(angle), rz * Math.cos(angle));
      const plateW = 2 * radiusHere * Math.sin(step / 2) * ARMOR_PLATE_OVERLAP;

      // Outermost plates of the upper bands become the shoulder caps.
      const edge = i === 0 || i === band.count - 1;
      const shoulder = edge && bandIndex <= 1 && !fragment;
      const grow = shoulder ? 1.5 : 1;

      const plate = MeshBuilder.CreateBox(
        "armor_plate",
        {
          width: plateW * grow,
          // Bands overlap vertically too, so no seam lines open between rows.
          height: plateH * ARMOR_BAND_OVERLAP * (shoulder ? 1.25 : 1) * (1 + jitter * 0.5),
          depth: thickness * (shoulder ? 1.8 : 1),
        },
        scene,
      );
      plate.position.set(rx * Math.sin(angle) * reach, band.y * height, rz * Math.cos(angle) * reach);
      // Face outward along the radial direction, then cant and roll slightly.
      plate.rotation.y = angle;
      plate.rotation.x = band.tilt + (hash01(n + 7) - 0.5) * 0.12;
      plate.rotation.z = (hash01(n + 13) - 0.5) * 0.14 + (shoulder ? (angle > 0 ? -0.4 : 0.4) : 0);
      parts.push(bakePart(plate));
    }
  });

  const merged = mergeOrThrow(parts, "proto_armor", scene);

  // No global sculpt pass here: irregularity is already baked into each plate's
  // reach/size/roll, and warping the merged result radially would pull the bands
  // out of alignment and reopen the seams the overlap is there to close.
  // Flat shading so every plate face catches light as its own facet.
  merged.convertToFlatShadedMesh();
  return finalizeProto(merged, "proto_armor");
}

/**
 * Ammo crate: a blocky box with a reinforced frame.
 *
 * Body slab, four corner posts, a rim strap top and bottom, and a lid slab —
 * all axis-aligned boxes standing slightly proud of the body so the crate reads
 * as built rather than as a single primitive. Flat-shaded to match the armor's
 * faceted language. The per-type icon is a separate mesh (buildAmmoIconProto)
 * so it can carry its own unlit decal material.
 */
export function buildAmmoCrateProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale * PROCEDURAL_GLOBAL_SCALE;
  const w = CRATE_W * s;
  const h = CRATE_H * s;
  const d = CRATE_D * s;
  const frame = Math.min(w, h, d) * CRATE_FRAME;
  const proud = frame * CRATE_FRAME_PROUD;

  const parts: Mesh[] = [MeshBuilder.CreateBox("crate_body", { width: w, height: h, depth: d }, scene)];

  // Corner posts: vertical bars at all four uprights.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = MeshBuilder.CreateBox("crate_post", { width: frame, height: h + proud, depth: frame }, scene);
      post.position.set(sx * (w / 2 - frame * 0.3), 0, sz * (d / 2 - frame * 0.3));
      parts.push(bakePart(post));
    }
  }

  // Rim straps: a band around the top and bottom edges, in two crossing bars so
  // the corners stay square without needing a mitred ring.
  for (const sy of [-1, 1]) {
    const y = sy * (h / 2 - frame * 0.5);
    const alongX = MeshBuilder.CreateBox("crate_strap", { width: w + proud, height: frame, depth: d }, scene);
    alongX.position.y = y;
    parts.push(bakePart(alongX));
    const alongZ = MeshBuilder.CreateBox("crate_strap", { width: w, height: frame, depth: d + proud }, scene);
    alongZ.position.y = y;
    parts.push(bakePart(alongZ));
  }

  // Lid: a slab sitting on top, slightly overhanging.
  const lid = MeshBuilder.CreateBox("crate_lid", { width: w * 0.94, height: h * CRATE_LID_H, depth: d * 0.94 }, scene);
  lid.position.y = h / 2 + (h * CRATE_LID_H) / 2 - frame * 0.2;
  parts.push(bakePart(lid));

  const merged = mergeOrThrow(parts, "proto_ammo_crate", scene);
  merged.convertToFlatShadedMesh();
  return finalizeProto(merged, "proto_ammo_crate");
}

/**
 * The four side decals of an ammo crate, merged into one mesh.
 *
 * One quad per vertical face, each turned to face outward and pushed just clear
 * of the body so the icon reads from any approach — the same "stamp the
 * simpleitem icon on the box" trick the old MD3 ammobox used, just generated.
 * Each quad keeps its own 0..1 UVs through the merge, so the shared decal
 * material paints the icon once per face.
 */
export function buildAmmoIconProto(scene: Scene, recipe: ProceduralPickupRecipe): Mesh {
  const s = recipe.scale * PROCEDURAL_GLOBAL_SCALE;
  const w = CRATE_W * s;
  const h = CRATE_H * s;
  const d = CRATE_D * s;
  const size = Math.min(w, h) * CRATE_ICON_FILL;
  const lift = Math.min(w, h, d) * CRATE_FRAME * CRATE_FRAME_PROUD + 0.35 * s;

  const quads: Mesh[] = [];
  // +Z / -Z faces, then +X / -X. `sideOrientation` is irrelevant here because
  // the decal material disables back-face culling.
  const faces: Array<{ pos: [number, number, number]; yaw: number }> = [
    { pos: [0, 0, d / 2 + lift], yaw: 0 },
    { pos: [0, 0, -(d / 2 + lift)], yaw: Math.PI },
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
