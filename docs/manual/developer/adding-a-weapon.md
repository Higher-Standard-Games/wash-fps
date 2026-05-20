# Adding a Weapon

A new weapon needs a definition in the shared entity registry, optionally a projectile definition, a slot in the weapon rack, and (for visible models) a model + barrel files under `public/data/models/weapons/`.

## TODO

This page is a stub. Full coverage to come:

- `WeaponDef` schema walk-through (from `src/shared/entities/WeaponDef.ts`)
- Projectile vs hitscan branches
- `barrels[]` definition for sub-mesh attachment
- HUD slot registration (`WEAPON_SLOTS` in `WeaponRack.ts`)
- Server-side ammo type registration
- Sound effect registration (fire / pickup keys via AudioManager)
- Worked example from start to finish

For now, copy an existing weapon (e.g. `riotgun.ts`) from `src/shared/entities/definitions/weapons/` as a starting point.
