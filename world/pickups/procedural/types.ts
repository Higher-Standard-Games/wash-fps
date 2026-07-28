/**
 * Procedural pickup recipe types (docs/research/PROCEDURAL_ITEMS.md §"Suggested
 * Recipe Data"). A recipe is the compact, tunable description of one health or
 * armor tier's generated sculpture — geometry counts, colors, and motion. It
 * lives entirely in the FPS client visual layer and carries no gameplay meaning;
 * amounts/caps/respawn timing remain server-authoritative.
 */

export type ProceduralPickupFamily = "health" | "armor" | "ammo";

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface ProceduralPickupRecipe {
  /** Registry id, e.g. "health_medium" / "armor_ya". Also the cache identity. */
  id: string;
  family: ProceduralPickupFamily;
  /** Tier kind, e.g. "small" | "mega" | "shard" | "ra". Cosmetic/label only. */
  kind: string;

  /** Core energy color (emissive). */
  color: RGB;
  /** Ring / plate / floor accent color. */
  accentColor: RGB;
  /** Overall size multiplier applied to all generated geometry. */
  scale: number;

  /** Orbiting rings around the core. */
  ringCount: number;
  /** Armor shield plates (0 for health). */
  plateCount: number;
  /** Rising motes. */
  moteCount: number;
  /** Health corona/shell petals around the core (large/mega). */
  shellPieces: number;
  /** Orbiting satellites (mega/ultra). */
  satelliteCount: number;

  /** Vertical bob amplitude (world units). */
  bobAmplitude: number;
  /** Bob frequency (cycles/sec). */
  bobFrequency: number;
  /** Yaw spin of the cosmetic root (degrees/sec). */
  spinSpeed: number;
  /** Emissive breathing frequency (cycles/sec). */
  pulseFrequency: number;
  /** Health adds a lateral figure-eight; armor is vertical-only. */
  figureEight: boolean;

  /** Faint vertical beacon strength 0..1 (mega/ultra/red). */
  beaconStrength: number;
  /** Collection transient flavor. */
  collectStyle: "collapse" | "shatter";
  /** Respawn assembly flavor. */
  respawnStyle: "assemble" | "materialize";
  /** High tier → longer collect/respawn transients (mega, ultra, red). */
  highTier: boolean;
  /** Ultra reads as an unstable alternate state (irregular ring axes, flicker). */
  unstable: boolean;

  /**
   * Ammo only: pk3 path of the Warsow simpleitem icon stamped on the crate's
   * sides (no extension — the loader tries the pk3 index then a loose `.tga`).
   * This is the same icon set the old MD3 ammobox used, so a crate still reads
   * as its ammo type at a glance.
   */
  iconTexture?: string;
}
