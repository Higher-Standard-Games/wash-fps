import type { AmmoDef } from "../../../../../../shared/entities/AmmoDef";
import { EntityType } from "../../../../../../shared/entities/EntityType";

export const INSTA_AMMO: AmmoDef = {
  id: "ammo_instas",
  name: "Insta Charges",
  type: EntityType.AMMO,
  classname: "ammo_instagun", // Warsow per-weapon name (what maps use)
  classnameAliases: ["ammo_instas"], // legacy Quake-style

  ammoType: "instas",
  amount: 5,

  modelPath: "models/items/ammo/ammobox/ammobox.md3",
  scale: 1.0,

  // Pickup glow (bright purple)
  glowColor: { r: 0.8, g: 0.2, b: 1.0 },
};
