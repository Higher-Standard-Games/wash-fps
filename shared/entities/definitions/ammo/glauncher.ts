import type { AmmoDef } from "../../../../../../shared/entities/AmmoDef";
import { EntityType } from "../../../../../../shared/entities/EntityType";
import { AMMO_BOX_MODEL, AMMO_BOX_SCALE } from "./box";

export const GRENADE_AMMO: AmmoDef = {
  id: "ammo_grenades",
  name: "Grenades",
  type: EntityType.AMMO,
  classname: "ammo_grenadelauncher", // Warsow per-weapon name (what maps use)
  classnameAliases: ["ammo_grenades"], // legacy Quake-style

  ammoType: "grenades",
  amount: 10,

  modelPath: AMMO_BOX_MODEL,
  scale: AMMO_BOX_SCALE,

  // Pickup glow (green)
  glowColor: { r: 0.3, g: 0.9, b: 0.2 },
};
