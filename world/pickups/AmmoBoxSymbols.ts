import { Material } from "@babylonjs/core/Materials/material";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { Scene } from "@babylonjs/core/scene";
import { loadAmmoIconTexture } from "./AmmoIconTexture";

/** The weapon symbol each ammo type shows, from washoi_gfx.pk3. */
const AMMO_SYMBOLS: Readonly<Record<string, string>> = {
  ammo_bullets: "machinegun",
  ammo_shells: "riot",
  ammo_grenades: "grenade",
  ammo_rockets: "rocket",
  ammo_plasmagun: "plasma",
  ammo_lasers: "laser",
  ammo_bolts: "electro",
};

/** The symbol's width as a share of the side it sits on. */
const SYMBOL_SIZE = 0.7;
/** How far out from the side the symbol floats, in the model's own units, so it never flickers into it. */
const SYMBOL_LIFT = 0.004;

/** The weapon symbol for an ammo id, or undefined for anything that is not ammo. */
export function ammoSymbolPath(ammoId: string): string | undefined {
  const symbol = AMMO_SYMBOLS[ammoId];
  return symbol ? `gfx/simpleitems/weapon/${symbol}` : undefined;
}

interface SymbolMaterial {
  ready: Promise<StandardMaterial | null>;
  material: StandardMaterial | null;
}

/**
 * One unlit material per symbol and scene, shared by every box of that ammo
 * type. The package textures go with the map that loaded them, so a material
 * whose texture is gone is built again for the next map: kept, it never draws,
 * and the next map waits on it until its load times out.
 */
const materials = new WeakMap<Scene, Map<string, SymbolMaterial>>();

function outlivedItsTexture(material: StandardMaterial): boolean {
  const texture = material.diffuseTexture;
  return !texture || texture.getInternalTexture() === null;
}

async function createSymbolMaterial(scene: Scene, path: string): Promise<StandardMaterial | null> {
  const texture = await loadAmmoIconTexture(path);
  if (!texture || scene.isDisposed) return null;
  texture.hasAlpha = true;
  const material = new StandardMaterial(`ammo_symbol_${path}`, scene);
  material.disableLighting = true;
  material.diffuseColor = Color3.Black();
  material.specularColor = Color3.Black();
  material.emissiveColor = Color3.White();
  material.diffuseTexture = texture;
  material.emissiveTexture = texture;
  material.useAlphaFromDiffuseTexture = true;
  material.transparencyMode = Material.MATERIAL_ALPHABLEND;
  return material;
}

function symbolMaterial(scene: Scene, path: string): Promise<StandardMaterial | null> {
  let byPath = materials.get(scene);
  if (!byPath) {
    byPath = new Map();
    materials.set(scene, byPath);
  }
  const cached = byPath.get(path);
  if (cached?.material && outlivedItsTexture(cached.material)) {
    cached.material.dispose();
    byPath.delete(path);
  } else if (cached) return cached.ready;
  const entry: SymbolMaterial = { ready: Promise.resolve(null), material: null };
  entry.ready = createSymbolMaterial(scene, path)
    .then((material) => {
      entry.material = material;
      return material;
    })
    .catch((error: unknown) => {
      console.warn(`[AmmoBoxSymbols] No symbol ${path}:`, error);
      return null;
    });
  byPath.set(path, entry);
  return entry.ready;
}

/**
 * Stamp an ammo type's weapon symbol on the four upright sides of its box.
 * Each is a quad parented to the box model, just off its side, so it turns,
 * bobs and hides with the model and is disposed with it. A box whose symbol
 * cannot load stays plain.
 */
export async function addAmmoBoxSymbols(box: Mesh, ammoId: string): Promise<void> {
  const path = ammoSymbolPath(ammoId);
  if (!path) return;
  const material = await symbolMaterial(box.getScene(), path);
  if (!material || box.isDisposed()) return;
  const { minimum, maximum } = box.getBoundingInfo().boundingBox;
  const centerY = (minimum.y + maximum.y) / 2;
  const width = maximum.x - minimum.x;
  const depth = maximum.z - minimum.z;
  // Each side: where it faces, and the turn that brings a plane's front (-Z) round to face it
  const sides = [
    { x: maximum.x + SYMBOL_LIFT, z: (minimum.z + maximum.z) / 2, turn: -Math.PI / 2, across: depth },
    { x: minimum.x - SYMBOL_LIFT, z: (minimum.z + maximum.z) / 2, turn: Math.PI / 2, across: depth },
    { x: (minimum.x + maximum.x) / 2, z: maximum.z + SYMBOL_LIFT, turn: Math.PI, across: width },
    { x: (minimum.x + maximum.x) / 2, z: minimum.z - SYMBOL_LIFT, turn: 0, across: width },
  ];
  sides.forEach((side, i) => {
    const size = side.across * SYMBOL_SIZE;
    const quad = MeshBuilder.CreatePlane(`${box.name}_symbol_${i}`, { size }, box.getScene());
    quad.material = material;
    quad.isPickable = false;
    quad.parent = box;
    quad.position.set(side.x, centerY, side.z);
    quad.rotation.y = side.turn;
  });
}
