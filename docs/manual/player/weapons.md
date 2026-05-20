# Weapons

Nine weapons, organized by slot. Numbers below are server-authoritative defaults from `src/shared/entities/definitions/weapons/*.ts` and the matching projectile definitions in `src/shared/entities/definitions/projectiles/*.ts`. Balance is still evolving — file an issue if anything feels off.

## At a Glance

| # | Weapon | Tag | Damage | Fire rate | Ammo | Notes |
|---|--------|-----|-------:|----------:|------|-------|
| 1 | **Blade** | BL | 80 (melee) / 50 (charged) | 2.0/s melee | Infinite | Default; charged shot is a projectile with large splash |
| 2 | **Machinegun** | MG | 10 | 10/s | bullets | Hitscan; high DPS at range |
| 3 | **Riotgun** | RG | 5 / pellet | 1.875/s | shells | Spread shotgun; close-range king |
| 4 | **Grenade Launcher** | GL | 80 (direct) / 80 splash | 1.5625/s | grenades | Arcing; bounces; 125 u splash radius |
| 5 | **Rocket Launcher** | RL | 80 (direct) / 80 splash | 1.5625/s | rockets | Straight-line projectile; 125 u splash; rocket jump is real |
| 6 | **Plasma Gun** | PG | 15 / bolt | 12.5/s | cells | Bolt projectile; 45 u splash; spam tool |
| 7 | **Voltaic** | VT | 7 / tick | 20/s | cells | Continuous beam |
| 8 | **Electrobolt** | EB | 75 | 0.8/s | bolts | Hitscan rail; long reload |
| 9 | **Instagun** | IG | 200 | 0.77/s | instas | Effectively one-shot; 80 u splash |

## Slot 1 — Blade

The default melee weapon. Replaces the older "gunblade" in the Q3 lineage.

- **Primary fire** — fast melee slash. 80 damage, ~100 unit reach, 500 ms cooldown (`fireRate: 2.0`).
- **Charged fire** — hold attack for 1 s to release a red energy projectile. 50 direct damage with a large 90-unit splash radius. Great for dueling at mid range where the melee swing won't connect.
- **Ammo** — infinite. The Blade is always usable.

Tactically the Blade rewards aggressive close play. The charged projectile is your forced opener when you have no other weapon, but the splash means you can blow yourself up — keep distance.

## Slot 2 — Machinegun

Hitscan, sustained DPS.

- **Damage** — 10 per shot.
- **Fire rate** — 10 shots/sec (100 ms reload).
- **Ammo** — `bullets`.
- **No splash, no projectile travel time.** Pure aim weapon.

The mid-range workhorse. Pair with strafe-jumping for hit-and-run tracking.

## Slot 3 — Riotgun

Shotgun spread, multiple pellets per shot.

- **Damage** — 5 per pellet.
- **Fire rate** — 1.875 shots/sec (533 ms reload; 20% faster than canonical Warsow).
- **Ammo** — `shells`.

Devastating at point-blank, useless beyond mid range. The Riotgun is what you finish bunny-hop ambushes with.

## Slot 4 — Grenade Launcher

Arcing projectile that bounces.

- **Damage** — 80 direct, 80 splash within 125 units.
- **Fire rate** — 1.5625 shots/sec (640 ms reload).
- **Ammo** — `grenades`.

Best for area denial and indirect angles. The arc makes lobbing into corridors and around corners straightforward; pre-aiming under doorways is the classic move. Grenade jumps work and are recoverable thanks to armor scaling.

## Slot 5 — Rocket Launcher

The headline weapon.

- **Damage** — 80 direct, 80 splash within 125 units.
- **Fire rate** — 1.5625 shots/sec (640 ms reload).
- **Ammo** — `rockets`.

Straight-line projectile. Predict your target's movement. Rocket-jumping is the cleanest way to traverse height differences — splash to your feet, accept the self-damage, gain enormous vertical.

## Slot 6 — Plasma Gun

Spammable bolt projectile.

- **Damage** — 15 per bolt + 5 splash within 45 units.
- **Fire rate** — 12.5 shots/sec.
- **Ammo** — `cells`.

The pressure tool. Hose down corridors, deny corners, finish off injured targets. The small splash radius means you can self-knockback without serious damage — useful for plasma climbing.

## Slot 7 — Voltaic

Continuous beam.

- **Damage** — 7 per tick.
- **Fire rate** — 20 ticks/sec.
- **Ammo** — `cells`.

Effective DPS 140/sec while held on target. Drinks cells. Pair with knockback-heavy weapons to immobilize then chain.

## Slot 8 — Electrobolt

Hitscan rail.

- **Damage** — 75.
- **Fire rate** — 0.8 shots/sec (1250 ms reload).
- **Ammo** — `bolts`.

High punish per shot, long reload. Stand your ground in long sightlines. Missing hurts — the reload is more than enough time for an enemy to reposition and answer.

## Slot 9 — Instagun

The cleanup gun.

- **Damage** — 200 (instakill for full-health, no-armor targets).
- **Fire rate** — 0.77 shots/sec (1300 ms reload).
- **Ammo** — `instas`.
- **Splash radius** — 80 units (small but present).

Reserved for specific gametype configurations. In any mode where the Instagun is enabled, ammo is the limiting factor — picking up an instas pack is a meaningful pickup.

## Knockback & Splash Damage

Every weapon with splash applies a server-authoritative impulse to anyone in the radius. The impulse vector is `target_pos - explosion_pos` normalised, scaled by per-weapon `knockbackScale`. The server queues this impulse and applies it *before* the affected entity's next movement tick, so the knockback's direction and magnitude are part of the authoritative simulation — not a client-side bandaid.

Self-knockback uses the same math. Rocket jumps, plasma climbs, grenade jumps — all real, all consistent client-side and server-side.

## ADS (Aim-Down-Sights)

Some weapons support ADS via Mouse 2 / right-click. The view zoom and reduced sway are cvar-controlled (`cl_ads_time`, etc.) and apply to the predicted local player only — remote players don't see your ADS state. Recoil scales down significantly while ADS is active.

The Blade does not support ADS. The Instagun is effectively always-precise.

## See Also

- [Pickups & Inventory](./pickups-and-inventory.md) — how weapon pickups work and the 3-slot limit
- [HUD](./hud.md) — reading the weapon rack and ammo counter
- [Movement](./movement.md) — strafe jumping and weapon-specific knockback
