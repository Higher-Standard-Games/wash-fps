# Weapons

Eight weapons, organized by slot. Numbers below are server-authoritative defaults from this game's `shared/entities/definitions/weapons/*.ts` and the matching projectile definitions in `shared/entities/definitions/projectiles/*.ts`. Balance is still evolving — file an issue if anything feels off.

Clip weapons play a short mechanical cue when a reload starts. Your own weapon
and a followed player's weapon use first-person audio; other players' reloads
come from their position. Repeated snapshots do not repeat the cue, and seeking
a demo does not replay an already-running reload.

## At a Glance

| # | Weapon | Tag | Damage | Fire rate | Ammo (reload) | Notes |
|---|--------|-----|-------:|----------:|------|-------|
| 1 | **Blade** | BL | 80 (melee) / 25–50 (charged) | 2.0/s melee | ∞ (none) | Default; step-in dash on each swing; charged shot is a projectile; +10 run speed |
| 2 | **Machinegun** | MG | 10 | 10/s | bullets (clip) | Hitscan; high DPS at range |
| 3 | **Riotgun** | RG | 5 / pellet | 1.25/s | shells (clip) | Spread shotgun; close-range king |
| 4 | **Grenade Launcher** | GL | 80 (direct) / 80 splash | 1.25/s | grenades (pool) | Arcing; bounces; 150 u splash radius |
| 5 | **Rocket Launcher** | RL | 80 (direct) / 80 splash | 1.25/s | rockets (pool) | Straight-line projectile; 150 u splash; rocket jump is real |
| 6 | **Plasma Gun** | PG | 15 / bolt | 10/s | cells (clip) | Bolt projectile; 45 u splash; spam tool |
| 7 | **Voltaic** | VT | 7 / tick | 20/s | lasers (clip) | Chain-lightning beam; unstable at the hip, precise under ADS |
| 8 | **Electrobolt** | EB | 75 | 0.8/s | bolts (pool) | Hitscan rail; long reload |

Fire rates were retuned for the corrected 125 Hz server tick (v0.9.16): the rocket/grenade launcher and riotgun all sit at **1.25/s (800 ms)**.

## Slot 1 — Blade

The default melee weapon. Replaces the older "gunblade" in the Q3 lineage.

- **Primary fire** — fast melee slash. 80 damage, ~100 unit reach, 500 ms cooldown (`fireRate: 2.0`).
- **Step-in dash** — an accepted swing lunges you ~64 units forward only while you hold forward and are already moving forward relative to your view (server-authoritative, `meleeDashDistance`). Forward diagonal movement qualifies; stationary, backward and sideways-only movement do not. Holding forward and back together cancels the dash. It's a horizontal position step, BSP-clamped against walls, with no lift or extra velocity.
- **Charged fire** — hold alt-fire and release to send a teal energy projectile (a `blade_blast`, speed 2500, no gravity). It needs at least 0.5 s of charge and does 25 damage at 0.5 s, rising to 50 at a full 1 s charge. Its knockback scale is 20, against 10 for a rocket. Great for dueling at mid range where the swing won't connect.
- **Agile** — carrying the Blade adds +10 to your run speed (410 u/s).
- **Ammo** — infinite. The Blade is always usable.

Tactically the Blade rewards aggressive close play. The charged projectile is your opener at range when you have no other weapon.

## Slot 2 — Machinegun

Hitscan, sustained DPS.

- **Damage** — 10 per shot.
- **Fire rate** — 10 shots/sec.
- **Ammo** — `bullets` (30-round clip — a real magazine, roughly 3 seconds of fire).
- **No splash, no projectile travel time.** Pure aim weapon.

The mid-range workhorse. Pair with strafe-jumping for hit-and-run tracking.

## Slot 3 — Riotgun

Shotgun spread, multiple pellets per shot.

- **Damage** — 5 per pellet × 18 pellets = 90 maximum. Pellet damage is rounded per hit, so a perfect point-blank shot is a 90, not a 100. **No headshot bonus:** a pellet that lands high counts as a body hit (see [Damage and Combat Rules](./combat.md#hit-locations)).
- **Fire rate** — 1.25 shots/sec (800 ms between shots).
- **Ammo** — `shells` (8-round clip).
- **Light** — +5 run speed while held.

Devastating at point-blank, useless beyond mid range. The Riotgun is what you finish bunny-hop ambushes with.

## Slot 4 — Grenade Launcher

Arcing projectile that bounces.

- **Damage** — 80 direct, 80 splash within 150 units.
- **Fire rate** — 1.25 shots/sec (800 ms between shots).
- **Ammo** — `grenades` (pool — no reload).
- **Ballistics** — retuned to a Warsow baseline: speed 900, gentle gravity, 3 bounces (each loses about half its speed) and a 1.5 s fuse.

Best for area denial and indirect angles. The arc makes lobbing into corridors and around corners straightforward; pre-aiming under doorways is the classic move. Grenade jumps work and are recoverable thanks to armor scaling.

## Slot 5 — Rocket Launcher

The headline weapon.

- **Damage** — 80 direct, 80 splash within 150 units.
- **Fire rate** — 1.25 shots/sec (800 ms between shots).
- **Ammo** — `rockets` (pool — no reload).

Straight-line projectile, speed 1814 u/s. Predict your target's movement. Rocket-jumping is the cleanest way to traverse height differences — splash to your feet, accept the self-damage, gain enormous vertical.

## Slot 6 — Plasma Gun

Spammable bolt projectile.

- **Damage** — 15 per bolt + 15 splash within 45 units.
- **Fire rate** — 10 shots/sec.
- **Ammo** — `cells` (50-round clip).

The pressure tool. Hose down corridors, deny corners, finish off injured targets. The small splash radius means you can self-knockback without serious damage — useful for plasma climbing.

## Slot 7 — Voltaic

Chain-lightning beam — its own weapon, not just a re-skinned lasergun.

- **Damage** — 7 per tick (≈140 DPS on target).
- **Fire rate** — 20 ticks/sec.
- **Ammo** — `lasers` (120-round clip). Its **own pool** — the Voltaic no longer shares the plasmagun's `cells`, so carrying both does not mean fighting over one ammo bar.
- **Chain lightning** — the beam arcs from its primary hit to up to **2 nearby enemies** within 280 units, at 50% falloff per hop (100% → 50% → 25%). All players see the arcs. Superb in crowded rooms.
- **Unstable hipfire** — fired from the hip the beam **wanders/bends** (`beamWanderDeg`, ~4°) — deliberately imprecise. **ADS (Mouse 2) locks it dead straight** (Warsow-LG feel). Aim down sights for range, spray from the hip up close.

## Slot 8 — Electrobolt

Hitscan rail.

- **Damage** — 75.
- **Fire rate** — 0.8 shots/sec (1250 ms reload).
- **Ammo** — `bolts`.

High punish per shot, long reload. It is a heavy weapon: **−25 run speed** while held (375 u/s). Stand your ground in long sightlines. Missing hurts — the reload is more than enough time for an enemy to reposition and answer.

## Empty Guns: Click, Then Trade

Pulling the trigger on a weapon with no ammo and nothing to reload from does not leave you stuck:

1. **First pull** — an empty click (and the out-of-ammo crosshair/HUD cue). Nothing else happens, so one mistimed tap never takes you off your rocket launcher.
2. **Second pull, or holding the trigger for about 0.2 s** — the server swaps you to the next weapon you own, in slot order, that can actually fire.

A weapon swapped in this way takes about 0.26 s to come up before it can fire, so the same trigger pull can't shoot straight out of a hand that still looks empty. A weapon you switch to yourself has no such delay, so firing straight out of a manual switch still works.

## Reload Models

Each weapon uses one of three ammo/reload models (`reloadModel` in its definition):

| Model | Weapons | Behavior |
|-------|---------|----------|
| **clip** | Machinegun (30), Riotgun (8), Plasma (50), Voltaic (120) | Magazine + reserve. Fire empties the clip, then **R** (or auto-reload) refills it from reserve; firing is blocked mid-reload. The HUD shows `clip / reserve`. |
| **pool** | Rocket L., Grenade L., Electrobolt | A single ammo count, no reload — fire until empty. |
| **none** | Blade | No ammo at all. |

Clip sizes in parentheses.

## Knockback & Splash Damage

Every weapon with splash applies a server-authoritative impulse to anyone in the radius. The impulse vector is `target_pos - explosion_pos` normalised, scaled by per-weapon `knockbackScale`. The server queues this impulse and applies it *before* the affected entity's next movement tick, so the knockback's direction and magnitude are part of the authoritative simulation — not a client-side bandaid.

Self-knockback uses the same math but is **halved**. See [Damage and Combat Rules](./combat.md). Rocket jumps, plasma climbs, grenade jumps — all real, all consistent client-side and server-side.

## ADS (Aim-Down-Sights)

Some weapons support ADS via Mouse 2 / right-click. The view zoom and reduced sway are cvar-controlled (`cl_ads_time`, etc.) and apply to the predicted local player only — remote players don't see your ADS state. Recoil scales down significantly while ADS is active.

Only Rocket and Grenade Launchers automatically aim when you press primary fire.
Plasma fires immediately from the hip with its 3° spread; Mouse 2 gives manual,
accurate ADS. It has no automatic sight raise or launcher firing delay.

Rocket and Grenade Launcher primary fire automatically raises the sights and
waits for the weapon's **160 ms** ADS time. Hold fire through that delay; releasing
early cancels the shot. Automatic aim still has spread: a **1° cone for rockets**
and **4° for grenades**. Holding Mouse 2 until ADS is complete gives a straight
shot; firing during manual ADS waits for the remaining raise time.

Electrobolt hipfire is instant but scatters within a **20° cone**, making it
unreliable at range. Complete its **375 ms** manual ADS for a straight shot.
Hipfire has a heavy upward/backward weapon kick like the Riotgun; aiming reduces it.
At close range the same angular spread causes less lateral displacement; there
is no distance-based accuracy switch. These three weapons' sight transitions use
their configured weapon ADS time rather than the cosmetic `cl_ads_time` setting.

The Blade does not support ADS.

## See Also

- [Pickups & Inventory](./pickups-and-inventory.md) — how weapon pickups work and the 3-slot limit
- [HUD](./hud.md) — reading the weapon rack and ammo counter
- [Movement](./movement.md) — strafe jumping and weapon-specific knockback
- [Search & Destroy](../gametypes/search-and-destroy.md) — the loadout mode, where you pick two of these to spawn with
