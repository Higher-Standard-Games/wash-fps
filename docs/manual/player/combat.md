# Damage and Combat Rules

How a hit becomes damage, armor loss and a push. These rules are the same for every weapon and are applied by the server, so what you see on your screen is advice and the server's tick is the truth.

A frag plays a kill-confirmation echo for the killer (also when following that
player or watching their demo POV). Suicides do not play it. Its volume follows
`cg_volume_hitsound`, alongside damage confirmation sounds, under the effects volume.

## Hit locations

Hitscan weapons (Machinegun, Riotgun, Voltaic, Electrobolt and the Blade) test where on the body the shot lands. The **Riotgun is the exception for the head**: see below.

| Location | Where | Damage |
|----------|-------|-------:|
| **Head** | The upper part of the body | **+25%** (×1.25) |
| **Body** | The middle | ×1 |
| **Legs** | The lower part of the body | −25% (×0.75) |

The head bonus applies the same to every weapon. It is enough to be felt on a fast weapon (a Machinegun round does 13 instead of 10) but won't decide a fight on its own. The heights are measured from the player's waist: a hit more than 20 units above it is a head hit, and one more than 20 below it is a leg hit.

A **head hit shows as an orange damage number** (instead of white, or yellow for a big hit) and **holds the crosshair's hit flash about half as long again**, so you can tell you got one.

**The Riotgun has no headshots.** Its pellets are a distributed blast, not an aimed shot, so a pellet that lands high counts as a body hit. Pellets that land low still count as leg hits, each one judged on its own, and their damage is added up into one number. Projectile and splash damage always counts as a body hit. Damage is rounded to whole numbers after multipliers, and stacks with Quad Damage.

## Armor

Armor is one 0–100 pool (see [Pickups → Armor](./pickups-and-inventory.md#armor-plate-model)). While you have armor, it **absorbs about two thirds (66%)** of each hit and you take the rest from health. The two drain together, and when the armor is gone you take the full hit.

Some damage ignores armor completely: **drowning**, **telefrags** and a **fatal fall** bypass it. Lava, slime and ordinary falls are absorbed like any other hit, and the 384–512 u band drains your armor outright (see [Fall damage](./movement.md#fall-damage)).

## Splash damage

Explosive weapons hurt everyone inside their radius, and the damage **falls off in a straight line** from full at the centre to a minimum at the edge:

| Weapon | Radius | At the centre | At the edge |
|--------|-------:|--------------:|------------:|
| Rocket Launcher | 150 u | 80 | 15 |
| Grenade Launcher | 150 u | 80 | 15 |
| Plasma Gun | 45 u | 15 | 5 |

A projectile that hits a player directly does its full direct damage (80 for rockets and grenades), and that player is not also hit by the splash from the same explosion. Everyone else in the radius takes the falloff damage.

Projectiles do not directly trigger on their shooter. Nearby world impacts,
including plasma hitting a close wall, apply the same splash falloff and the
gametype's self-damage multiplier. Muzzle offsets are traced against the world
so a close wall cannot place the projectile on its far side.

## Knockback

Every hit pushes the victim away from the shot or explosion. The push is **damage × the weapon's knockback scale**, so high-damage, high-scale weapons shove hardest (rockets and grenades scale 10, the Electrobolt 3.5, the Machinegun 2). A few rules shape it:

- **The push has an upward bias**, so even a flat hit lifts you a little.
- **Self-knockback is halved** compared with the same hit on an enemy. Rocket jumps are still strong, just not twice as strong.
- **Quad Damage multiplies knockback too**, along with damage (×4), including on yourself.
- **Stun.** A hit also strips horizontal speed from the victim, in proportion to the damage dealt (100 damage takes 80%, the maximum), so taking a hit mid-strafe-jump costs you momentum.

## Self damage

Your own explosions hurt you at the gametype's self-damage setting, which is full (×1.0) in every shipped mode. You still get pushed even when self-damage is turned down to nothing. Armor protects you from your own rockets exactly as it does from anyone else's.

## Other damage

| Source | Notes |
|--------|-------|
| **Falls** | See [Movement → Fall damage](./movement.md#fall-damage) |
| **Drowning, slime, lava** | See [Movement → Water](./movement.md#water-and-other-liquids); only drowning bypasses armor |
| **Crushing** | A blocked mover damages you; see [Movement → Lifts](./movement.md#lifts-doors-and-movers). It counts as world damage and is credited to nobody |
| **Telefrag** | Standing on a teleporter exit kills you instantly and credits the player who arrived |
| **Friendly fire** | On in Search & Destroy; avoid shooting teammates. See [Friendly fire](../gametypes/search-and-destroy.md#friendly-fire) |

## Lag compensation

For weapons that use it (Machinegun, Riotgun, Voltaic and Electrobolt; not the Blade or any projectile weapon), the server rewinds other players to the moment your client was showing you before testing the shot, so a shot that was on target on your screen hits. See [Connecting](../multiplayer/connecting.md#reading-the-netgraph).

## See also

- [Weapons](./weapons.md) — each weapon's damage, rate and ammo
- [HUD](./hud.md) — damage numbers, hit flash and the damage direction arrows
