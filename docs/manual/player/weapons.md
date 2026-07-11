# Weapons

Nine weapons, organized by slot. Numbers below are server-authoritative defaults from `src/shared/entities/definitions/weapons/*.ts` and the matching projectile definitions in `src/shared/entities/definitions/projectiles/*.ts`. Balance is still evolving — file an issue if anything feels off.

## At a Glance

| # | Weapon | Tag | Damage | Fire rate | Ammo (reload) | Notes |
|---|--------|-----|-------:|----------:|------|-------|
| 1 | **Blade** | BL | 80 (melee) / 50 (charged) | 2.0/s melee | ∞ (none) | Default; step-in dash on each swing; charged shot is a splash projectile |
| 2 | **Machinegun** | MG | 10 | 10/s | bullets (clip) | Hitscan; high DPS at range |
| 3 | **Riotgun** | RG | 5 / pellet | 1.25/s | shells (clip) | Spread shotgun; close-range king |
| 4 | **Grenade Launcher** | GL | 80 (direct) / 80 splash | 1.25/s | grenades (pool) | Arcing; bounces; 150 u splash radius |
| 5 | **Rocket Launcher** | RL | 80 (direct) / 80 splash | 1.25/s | rockets (pool) | Straight-line projectile; 150 u splash; rocket jump is real |
| 6 | **Plasma Gun** | PG | 15 / bolt | 12.5/s | cells (clip) | Bolt projectile; 45 u splash; spam tool |
| 7 | **Voltaic** | VT | 7 / tick | 20/s | cells (clip) | Chain-lightning beam; unstable at the hip, precise under ADS |
| 8 | **Electrobolt** | EB | 75 | 0.8/s | bolts (pool) | Hitscan rail; long reload |
| 9 | **Instagun** | IG | 200 | 0.77/s | instas (pool) | Effectively one-shot; 80 u splash + insta-jump |

Fire rates were retuned for the corrected 125 Hz server tick (v0.9.16): the rocket/grenade launcher and riotgun all sit at **1.25/s (800 ms)**.

## Slot 1 — Blade

The default melee weapon. Replaces the older "gunblade" in the Q3 lineage.

- **Primary fire** — fast melee slash. 80 damage, ~100 unit reach, 500 ms cooldown (`fireRate: 2.0`).
- **Step-in dash** — every accepted swing lunges you ~48 units forward (server-authoritative, `meleeDashDistance`). It's a horizontal position step, not knockback — no lift, no air-drag — and it's BSP-clamped so you never phase through walls. This is what makes the Blade a real closing tool: swing to cover the last gap.
- **Charged fire** — hold alt-fire for 1 s to release a red energy projectile (a `gunblade_blast`). 50 direct damage with an 80-unit splash. Great for dueling at mid range where the swing won't connect.
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
- **Fire rate** — 1.25 shots/sec (800 ms between shots).
- **Ammo** — `shells`.

Devastating at point-blank, useless beyond mid range. The Riotgun is what you finish bunny-hop ambushes with.

## Slot 4 — Grenade Launcher

Arcing projectile that bounces.

- **Damage** — 80 direct, 80 splash within 150 units.
- **Fire rate** — 1.25 shots/sec (800 ms between shots).
- **Ammo** — `grenades` (pool — no reload).
- **Ballistics** — retuned to a Warsow baseline: speed ~900, gentle gravity, 3 bounces before it explodes.

Best for area denial and indirect angles. The arc makes lobbing into corridors and around corners straightforward; pre-aiming under doorways is the classic move. Grenade jumps work and are recoverable thanks to armor scaling.

## Slot 5 — Rocket Launcher

The headline weapon.

- **Damage** — 80 direct, 80 splash within 150 units.
- **Fire rate** — 1.25 shots/sec (800 ms between shots).
- **Ammo** — `rockets` (pool — no reload).

Straight-line projectile. Predict your target's movement. Rocket-jumping is the cleanest way to traverse height differences — splash to your feet, accept the self-damage, gain enormous vertical.

## Slot 6 — Plasma Gun

Spammable bolt projectile.

- **Damage** — 15 per bolt + 5 splash within 45 units.
- **Fire rate** — 12.5 shots/sec.
- **Ammo** — `cells`.

The pressure tool. Hose down corridors, deny corners, finish off injured targets. The small splash radius means you can self-knockback without serious damage — useful for plasma climbing.

## Slot 7 — Voltaic

Chain-lightning beam — its own weapon, not just a re-skinned lasergun.

- **Damage** — 7 per tick (≈140 DPS on target).
- **Fire rate** — 20 ticks/sec.
- **Ammo** — `cells`.
- **Chain lightning** — the beam arcs from its primary hit to up to **2 nearby enemies** at per-hop falloff (`chainCount` / `chainRadius` / `chainFalloff`). All players see the arcs. Superb in crowded rooms.
- **Unstable hipfire** — fired from the hip the beam **wanders/bends** (`beamWanderDeg`, ~4°) — deliberately imprecise. **ADS (Mouse 2) locks it dead straight** (Warsow-LG feel). Aim down sights for range, spray from the hip up close.

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
- **Insta-jump** — the splash applies **knockback but no self-damage**, so you can launch yourself off your own feet without dying (instagib-style rocket jumps). The launch always applies even when self-damage is gated to zero.

Reserved for specific gametype configurations. In any mode where the Instagun is enabled, ammo is the limiting factor — picking up an instas pack is a meaningful pickup.

## Reload Models

Each weapon uses one of three ammo/reload models (`reloadModel` in its definition):

| Model | Weapons | Behavior |
|-------|---------|----------|
| **clip** | Machinegun, Riotgun, Plasma, Voltaic | Magazine + reserve. Fire empties the clip, then **R** (or auto-reload) refills it from reserve; firing is blocked mid-reload. The HUD shows `clip / reserve`. |
| **pool** | Rocket L., Grenade L., Electrobolt, Instagun, Gunblade | A single ammo count, no reload — fire until empty. |
| **none** | Blade | No ammo at all. |

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
