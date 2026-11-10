import type { AmmoDef } from "../../../../../../shared/entities/AmmoDef";
import { EntityType } from "../../../../../../shared/entities/EntityType";
import { AMMO_BOX_MODEL, AMMO_BOX_SCALE } from "./box";

export const PLASMA_AMMO: AmmoDef = {
  id: "ammo_plasmagun",
  name: "Plasma Cells",
  type: EntityType.AMMO,
  classname: "ammo_plasmagun",

  ammoType: "cells",
  amount: 50,

  modelPath: AMMO_BOX_MODEL,
  scale: AMMO_BOX_SCALE,

  // Pickup glow (green like plasmagun)
  glowColor: { r: 0.3, g: 1.0, b: 0.3 },
};
