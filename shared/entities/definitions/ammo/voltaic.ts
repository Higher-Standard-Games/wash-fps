/**
 * Voltaic (laser) Ammo — the beam weapon's own pool.
 *
 * Lasers used to share the `cells` pool with the plasmagun, so a plasma box
 * topped up your beam and vice versa. They are separate pools now, matching
 * Warsow: LG drinks `lasers`, PG drinks `cells`. The shipping maps already place
 * these as distinct classnames — `ammo_lasergun` (54 placements across 35 maps)
 * and `ammo_plasmagun` (36 / 28) — so the split needs no map changes. The
 * primary classname is the one maps actually use; `ammo_lasers` is a legacy
 * alias that no shipping map places.
 */

import type { AmmoDef } from "../../../../../../shared/entities/AmmoDef";
import { EntityType } from "../../../../../../shared/entities/EntityType";

export const VOLTAIC_AMMO: AmmoDef = {
  id: "ammo_lasers",
  name: "Laser Cells",
  type: EntityType.AMMO,
  classname: "ammo_lasergun",
  classnameAliases: ["ammo_lasers"],

  ammoType: "lasers",
  amount: 100,

  modelPath: "models/items/ammo/ammobox/ammobox.md3",
  scale: 1.0,

  // Pickup glow (electric cyan, matches voltaic)
  glowColor: { r: 0.2, g: 0.8, b: 1.0 },
};
