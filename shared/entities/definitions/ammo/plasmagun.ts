import type { AmmoDef } from "../../../../../../shared/entities/AmmoDef";
import { EntityType } from "../../../../../../shared/entities/EntityType";

export const PLASMA_AMMO: AmmoDef = {
  id: "ammo_plasmagun",
  name: "Plasma Cells",
  type: EntityType.AMMO,
  classname: "ammo_plasmagun",

  ammoType: "cells",
  amount: 50,

  scale: 1.0,

  // Pickup glow (green like plasmagun)
  glowColor: { r: 0.3, g: 1.0, b: 0.3 },
};
