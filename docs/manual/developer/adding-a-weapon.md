# Adding a Weapon

Weapons are **data**: one definition object in the engine's shared entity registry, read by the server for ballistics and by the client for display. Neither side has per-weapon code for the ordinary cases, so most new weapons are a new definition file plus a handful of registrations.

The concrete definitions live in this game repo under `shared/entities/`, shared
by the client and server. Generic interfaces and the registry remain in the
engine's `src/shared/entities/`:

| File | Holds |
|------|-------|
| Engine: `src/shared/entities/WeaponDef.ts` | The `WeaponDef` type, every field documented |
| `definitions/weapons/*.ts` | One file per weapon (`riotgun.ts` is a good template) |
| `definitions/weapons/WeaponsTable.ts` | The `WEAPONS` lookup the server and client both use |
| `definitions/projectiles/*.ts` | Projectile definitions, for weapons that fire one |
| `definitions/ammo/*.ts` | Ammo pickups, one per ammo type |
| `initEntityDefs.ts` | Registers every definition with the entity registry at startup |

## Steps

1. **Copy a similar weapon.** Hitscan: `machinegun.ts` or `electrobolt.ts`. Pellets: `riotgun.ts`. Projectile: `rlauncher.ts`. Beam: `voltaic.ts`. Melee: `blade.ts`.
2. **Fill in the `WeaponDef`.** The fields that matter most:

   | Field | Meaning |
   |-------|---------|
   | `id`, `name`, `classname` | Identity. The classname (`weapon_riotgun`) is what maps place |
   | `damage`, `fireRate` | Damage per hit and shots per second. The server ticks at 125 Hz, so a rate that does not divide 125 exactly is rounded to whole ticks |
   | `reloadModel`, `clipSize`, `ammoType`, `maxAmmo`, `reloadTime`, `pickupAmmo` | Ammo. `clip` has a magazine and reserve, `pool` is a single count, `none` never runs dry. Weapons of the same `ammoType` share a pool |
   | `hitscan`, `hitscanType` | Instant hit (`tracer`, `pellet`, `beam`, `bolt`), or leave off and set `projectileId` |
   | `spread`, `adsSpread`, `pelletCount` | Accuracy, in degrees |
   | `projectileId`, `projectileSpeed`, `projectileGravity` | For projectile weapons |
   | `splashRadius`, `splashDamage`, `knockbackScale` | Explosions and knockback. Knockback is damage × scale |
   | `speedBonus` | Added to your run speed while the weapon is held (negative for heavy weapons) |
   | `useLagCompensation` | Whether the server rewinds targets for this weapon's hits |
   | `viewModel`, `muzzleFlash`, `ads`, `crosshair`, `sounds` | Presentation: the first-person model and its hip and ADS offsets, flash, zoom and the crosshair style |
   | `barrels` | Spinning sub-meshes (a minigun's barrels) |

   The weapon's melee, charge and chain fields (`meleeDashDistance`, `chargeTime`, `chainCount`, `beamWanderDeg`, ...) are optional and only read for the weapons that use them.
3. **Export it** from `definitions/weapons/index.ts` and add it to the `WEAPONS` table in `WeaponsTable.ts`. A projectile also needs an alias entry there (`rocket: ROCKET_LAUNCHER`), because the projectile system looks up damage and splash by projectile id. If you add a projectile, define it in `definitions/projectiles/` as well.
4. **Register the definitions** in `initEntityDefs.ts`.
5. **Add its ammo**, if it uses a new type: a definition in `definitions/ammo/`, registered the same way.
6. **Let maps place it.** Add the classname to `CLASSNAME_TO_WEAPON` in `src/shared/bsp/PickupTable.ts` (shared by client and server, which is what keeps pickup ids matching on both sides). Add ammo classnames next to it.
7. **Give it a slot on the HUD.** In this repo, add an entry to `WEAPON_SLOTS` in `client/hud/widgets/WeaponRack.ts` with its two-letter tag. Slots are bound to the number keys 1–9, so the game has room for nine weapons without adding another action to `client/FPSActions.ts`.
8. **Models and sounds.** Put the model under `public/data/models/weapons/<id>/` in the engine repo, and the sounds at the paths the definition names.
9. **Offer it in a loadout**, if a mode should be able to pick it: `PRIMARY_CHOICES` or `SECONDARY_CHOICES`, and its spawn ammo, in the shared loadout module (`src/shared/server/gametype/Loadout.ts`).
10. **Test it.** The weapon tests live next to the systems (`server/systems/__tests__/`). A new weapon should get at least a fire-rate, ammo and damage test.

## Things that catch people

- **Compatibility ids.** `lasergun` is an alias for Voltaic (`WeaponsTable.ts`), carried by older maps and mods. New weapons don't need one.
- **Client and server share one definition.** A stat change affects both prediction and the server's ballistics at once, and demos record the match, not the definitions, so re-simulating an old demo against a retuned weapon will not reproduce it.
- **Pickup respawn is not per weapon.** All weapons respawn on one timer; see [Pickups & Inventory](../player/pickups-and-inventory.md#pickup-respawn).
- **Update the manual.** Add the weapon to [Weapons](../player/weapons.md).
