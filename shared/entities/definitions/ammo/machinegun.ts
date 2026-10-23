import type { AmmoDef } from "../../../../../../shared/entities/AmmoDef";
import { EntityType } from "../../../../../../shared/entities/EntityType";

export const BULLET_AMMO: AmmoDef = {
  id: "ammo_bullets",
  name: "Bullets",
  type: EntityType.AMMO,
  classname: "ammo_machinegun", // Warsow per-weapon name (what maps use)
  classnameAliases: ["ammo_bullets"], // legacy Quake-style

  ammoType: "bullets",
  amount: 50,

  modelPath: "models/items/ammo/ammobox/ammobox.md3",
  scale: 1.0,

  // Pickup glow (yellow)
  glowColor: { r: 1.0, g: 0.9, b: 0.3 },
};
