import type { AmmoDef } from "../../../../../../shared/entities/AmmoDef";
import { EntityType } from "../../../../../../shared/entities/EntityType";

export const GRENADE_AMMO: AmmoDef = {
  id: "ammo_grenades",
  name: "Grenades",
  type: EntityType.AMMO,
  classname: "ammo_grenadelauncher", // Warsow per-weapon name (what maps use)
  classnameAliases: ["ammo_grenades"], // legacy Quake-style

  ammoType: "grenades",
  amount: 10,

  modelPath: "models/items/ammo/ammobox/ammobox.md3",
  scale: 1.0,

  // Pickup glow (green)
  glowColor: { r: 0.3, g: 0.9, b: 0.2 },
};
