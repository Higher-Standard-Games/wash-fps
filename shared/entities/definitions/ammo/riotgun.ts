import type { AmmoDef } from "../../../../../../shared/entities/AmmoDef";
import { EntityType } from "../../../../../../shared/entities/EntityType";
import { AMMO_BOX_MODEL, AMMO_BOX_SCALE } from "./box";

export const SHELL_AMMO: AmmoDef = {
  id: "ammo_shells",
  name: "Shells",
  type: EntityType.AMMO,
  classname: "ammo_riotgun", // Warsow per-weapon name (what maps use)
  classnameAliases: ["ammo_shells"], // legacy Quake-style

  ammoType: "shells",
  amount: 10,

  modelPath: AMMO_BOX_MODEL,
  scale: AMMO_BOX_SCALE,

  // Pickup glow (warm orange)
  glowColor: { r: 1.0, g: 0.6, b: 0.2 },
};
