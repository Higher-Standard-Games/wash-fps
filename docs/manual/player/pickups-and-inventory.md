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
| **Weapon** | Adds the weapon to your inventory if you have room; otherwise prompts you to swap. | `weapon_rocketlauncher`, `weapon_riotgun` |
| **Ammo** | Adds to your ammo pool. Auto-pickup on touch. | `ammo_rockets`, `ammo_shells` |
| **Health** | Restores HP (see below). | `item_health_small/large/mega/ultra` |
| **Armor** | Adds armor plates (see below). | `item_armor_shard/ga/ya/ra` |

### Armor — plate model

Armor is **one 0–100 pool** presented as **four plates × 25** (Call-of-Duty style, masked behind the classic Quake armor names). Damage depletes the pool continuously (~66% of incoming damage is absorbed by armor); plates only matter at *pickup* time — inserting a plate tops your current partial plate up to its 25-boundary:

| Pickup | Classname | Effect |
|--------|-----------|--------|
| Shard | `item_armor_shard` | +5 flat |
| Green Armor | `item_armor_ga` | +1 plate (round up to the next 25, then +25) — e.g. 58 → 75 |
| Yellow Armor | `item_armor_ya` | +2 plates |
| Red Armor | `item_armor_ra` | fill to 100 |

### Health

| Pickup | Classname | Effect |
|--------|-----------|--------|
| Small | `item_health_small` | +25, capped at 100 |
| Large | `item_health_large` | +50, capped at 100 |
| Mega / Ultra | `item_health_mega` / `_ultra` | +100 **overhealing to 200**, then decaying 1 HP/s back toward 100 |

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

Map-spawned pickups respawn on a per-type timer: **weapons 15s, armor 25s, health 20s, mega health 60s.** Armor and mega/ultra health are also **absent for the first 15s of a match** so nobody grabs a power item off spawn. Dropped weapons do **not** respawn — they're one-and-done.

## Powerups

Timed pickups that modify you until they run out. Currently one is implemented:

| Powerup | Effect | Duration | Respawn |
|---------|--------|---------:|--------:|
| **Quad Damage** | ×4 damage and knockback on everything you deal | 30 s | 120 s |

Things worth knowing:

- **Quad scales everything, including self-damage.** A quad rocket jump throws
  you four times as far and usually kills you. That trade is the point.
- **Re-taking extends, it does not reset.** Picking up a quad you already hold
  adds a full 30 seconds to what is left.
- **Every shipped map places exactly one `item_quad`**, so the 120-second
  respawn is the whole map-control rhythm — long enough that holding it is
  worth fighting over.
- Expiry is stored as an absolute **server tick**, not a countdown. That is what
  keeps it exact through rollback and demo re-simulation, and it means the HUD
  timer is a read of authoritative state rather than a local guess.

`item_warshell` and `item_regen` exist in the map data and in the pk3 icon and
sound banks, but are deliberately **not** implemented.

## Loadouts (Search & Destroy)

In [Search & Destroy](../gametypes/search-and-destroy.md) you do not start with
just a blade — you spawn with a chosen kit of **blade + one primary + one
secondary**, plus full spawn armor. Map items still spawn on top of that.

The choice applies from the **next** round. Pick it from the HUD's loadout
picker during the freeze, or from the console:

```
loadout rlauncher machinegun
```

Everywhere else, the spawn loadout is blade-only and the map is the whole
economy.

## Server-Authoritative Active Set

Pickups are fully server-authoritative and *convergent*. Rather than one-shot "you took it" events, **every snapshot carries a packed bitmask of which pickups are currently active** (`pickupActiveMask`, bit index = pickup id). The client reconciles each pickup's visibility to the mask every frame.

Two properties fall out of this:

- **Self-healing.** A dropped packet can't cause a "ghost weapon" (visible but ungrantable) — the next snapshot re-states the truth and the client converges.
- **Provably matching ids.** Both server and client derive the pickup list and its ids from the *same* BSP entity table (`extractPickups` in `src/shared/bsp/PickupTable.ts`), so pickup id N means the same object on both sides with no handshake. Unresolved ids fail *closed* (no phantom pickup) rather than guessing by position.

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
- The engine's Pickup System Guide (`docs/manual/guides/pickup-system.md` in the engine repo) — the engine-generic `Pickup` base class that `FPSPickup` extends
