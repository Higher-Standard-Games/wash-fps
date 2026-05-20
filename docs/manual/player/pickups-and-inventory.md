# Pickups & Inventory

Pickups are server-authoritative — the server decides who gets what and when. Your client only renders the world objects and shows the HUD prompts.

## Inventory Model

Washiki Washoi uses a **3-slot COD-style inventory**:

| Slot | Default | Swappable? |
|------|---------|------------|
| 1 | Blade (melee) | No — always equipped |
| 2 | (empty) | Yes — picked up |
| 3 | (empty) | Yes — picked up |

You can carry the Blade plus up to two other weapons. Picking up a fourth weapon prompts for a swap (see below). Ammo is tracked per-type (not per-weapon):

```
shells / bullets / rockets / cells / grenades / bolts / instas / blade(∞) / lasers
```

The total ammo pool is shared across weapons of the same ammo type. Ammo pickups add to your pool; capacity defaults to 200 (per type).

## Pickup Types

| Type | Effect | Examples |
|------|--------|----------|
| **Weapon** | Adds the weapon to your inventory if you have room; otherwise prompts you to swap. | rocket, riotgun, plasmagun |
| **Ammo** | Adds to your ammo pool. Auto-pickup on touch. | `ammo_rockets`, `ammo_shells` |
| **Health** | Restores HP. | `item_health_25`, `item_health_50` |
| **Armor** | Adds armor. | `item_armor_green` (50), `item_armor_yellow` (100), `item_armor_red` (200) |

## Walking Over a Weapon Pickup

The client checks proximity every frame (cylindrical region around the pickup: 96 unit radius, -24 to +88 vertical band). When you enter the region:

- **You don't have the weapon, and you have a free slot** → server auto-gives you the weapon. No prompt.
- **You already have the weapon** → server auto-gives you the weapon's default ammo. No prompt.
- **All three slots are full + you don't have this weapon + your equipped weapon is the Blade** → server still auto-swaps. No prompt (the Blade is always free to drop).
- **All three slots full + you don't have this weapon + your equipped weapon is NOT the Blade** → HUD prompt: `PRESS [F] TO SWAP TO <WEAPON>`. The server waits for your USE button (default F). On press, it drops your currently equipped weapon and gives you the new one.

## Walking Over an Ammo Pickup

Server auto-gives the ammo on touch. The HUD ammo counter updates immediately. No prompt.

## Dropped Weapons

When a player dies, their non-Blade weapons drop as physical entities with Havok dynamic-body tumble. They land via BSP collision, settle, and become regular weapon pickups that other players can grab. Dropped weapons carry the ammo their owner had at the moment of death.

## Pickup Respawn

Map-spawned pickups have a respawn timer (default 30 seconds for weapons, varies per pickup definition). The mesh hides on pickup, the pickup is marked inactive, and a `setTimeout` fires to make it active and visible again. Dropped weapons do **not** respawn — they're one-and-done.

## Server-Authoritative Deactivation

The technical contract (for completeness; players never see this):

1. The server's `PickupSystem` decides a pickup is taken.
2. It emits an `item_pickup` event with `pickupId`, `weaponId`, and `x/y/z` over the network.
3. The client routes the event to `FPSPickup.deactivateById(...)`.
4. The static registry on `FPSPickup` looks up the pickup by id (or falls back to position match if the id missed — this can happen during map load races).
5. The matching pickup's `deactivateFromServer()` runs: plays the sound, hides the mesh, freezes physics, schedules the respawn timer.

Position matching is XZ-only (Y is ignored because the client's `dropToGround` raycast usually puts pickups at a different Y than the server's raw entity position). Closest-match wins when multiple pickups share a weapon id.

There's a 10-second deferred-deactivation queue for the race where a pickup-event arrives before the client has constructed the pickup (during map load). After 10 s, queued events are dropped.

## Inventory API (for developers)

`InventoryManager` lives at `src/games/fps/world/InventoryManager.ts` and is exposed on `FPSPlayer.inventory`. Notable methods:

- `giveWeapon(weaponId)` — returns `{ acquired, dropped }`; if at capacity, drops the currently equipped weapon.
- `removeWeapon(weaponId)` — manual remove.
- `setCurrentWeapon(weaponId)` — switch equipped slot.
- `giveAmmo(type, amount)` — adds to the type pool.
- `setAmmo(type, amount)` — set absolute.
- `getAmmo(type)` — current count for a type.
- `getSlotCount()` — how many slots are filled.
- `hasWeapon(weaponId)` — boolean.
- `MAX_WEAPONS` (static) — 3 by design; see the comment in `InventoryManager.ts`.

## See Also

- [Weapons](./weapons.md) — per-weapon stats and ammo types
- [HUD](./hud.md) — reading the weapon slots + ammo counter
- The engine's [Pickup System Guide](../../../../../docs/manual/guides/pickup-system.md) — the engine-generic `Pickup` base class that `FPSPickup` extends
