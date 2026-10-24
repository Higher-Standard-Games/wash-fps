import type { AmmoDef } from "../../../../../../shared/entities/AmmoDef";
import { EntityType } from "../../../../../../shared/entities/EntityType";

export const BOLT_AMMO: AmmoDef = {
  id: "ammo_bolts",
  name: "Electro Bolts",
  type: EntityType.AMMO,
  classname: "ammo_electrobolt", // Warsow per-weapon name (what maps use)
  classnameAliases: ["ammo_bolts"], // legacy Quake-style

  ammoType: "bolts",
  amount: 10,

  scale: 1.0,

  // Pickup glow (electric blue)
  glowColor: { r: 0.3, g: 0.5, b: 1.0 },
};
