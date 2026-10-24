import type { AmmoDef } from "../../../../../../shared/entities/AmmoDef";
import { EntityType } from "../../../../../../shared/entities/EntityType";

export const ROCKET_AMMO: AmmoDef = {
  id: "ammo_rockets",
  name: "Rockets",
  type: EntityType.AMMO,
  classname: "ammo_rocketlauncher", // Warsow per-weapon name (what maps use)
  classnameAliases: ["ammo_rockets"], // legacy Quake-style

  ammoType: "rockets",
  amount: 10,

  scale: 1.0,

  // Pickup glow (red-orange)
  glowColor: { r: 1.0, g: 0.4, b: 0.1 },
};
