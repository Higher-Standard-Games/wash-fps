# Search & Destroy

Round-based bomb and defuse, ported from Warsow Bomb. One team carries a bomb
to one of two sites and arms it; the other team stops them, or defuses it.

**No respawns inside a round.** When you die you stay dead until the round ends.
That single rule is what makes the mode play differently from everything else in
the game: positioning, information and trades matter more than aim.

## Match Shape

| Setting | Value |
|---------|------:|
| Round length | 90 s |
| Freeze before each round | 10 s |
| Round-end intermission | 5 s |
| Rounds to win | 10 |
| Lead required | 2 |
| Rounds per half | 9 |
| Team spawn protection | 3 s |

The lead requirement means 10–9 is not a win — the match continues until one
team is two rounds clear. Sides swap at halftime, so both teams attack and
defend the same number of rounds.

> Warsow ships 60-second rounds and a limit of 16. Washiki Washoi uses 90 and 10:
> the round length was chosen against traversal times measured on the real bomb
> maps, and a shorter match suits a game with no economy to carry across a half.

## The Bomb

Timings are Warsow's shipped defaults (`g_bomb_armtime`, `g_bomb_defusetime`,
`g_bomb_bombtimer`), converted to the 125 Hz tick:

| Action | Time | Radius |
|--------|-----:|-------:|
| Arm (attackers) | 4 s | 100 u |
| Defuse (defenders) | 7 s | 100 u |
| Fuse (armed → detonation) | 30 s | — |
| Pick up a dropped bomb | instant | 64 u |

Other rules that decide rounds:

- **You cannot plant while moving fast.** Above 400 u/s the plant is refused.
  Land, slow down, then plant.
- **You must be on flat ground.** The surface under you needs a normal within
  ~26° of vertical. This deliberately removes ramp plants — wbomb1's B ramp is
  not a plant spot.
- **Arming and defusing share one radius.** Anyone inside 100 u of the planted
  bomb can work on it; the plant *zone* (the site area) is much larger and only
  decides where you may plant at all.
- **The beep accelerates.** Interval is a twelfth of the time remaining,
  clamped between 5 s and 200 ms. It is a shared clock — both teams hear the
  same beep at the same time.

Once the bomb is armed, the round no longer ends on the round timer. The fuse
takes over: defenders must defuse or lose, whatever the clock says.

On maps with destructible site structures, detonation removes those structures
and their collision after the map's authored delay, revealing the damaged layout
and throwing debris. The next round restores the intact site. Spectators joining
after the explosion see the damaged layout without replaying old debris.

Attackers hear “in place” when the bomb is set down. Both sides hear the planted
announcement when arming completes and the fuse starts.

## Attackers and Defenders

Teams are the usual **udon** and **soba**. Which one attacks is decided per
half and swaps at halftime.

Attackers spawn in the map's **beta** area and defenders in the **alpha** area,
whichever team is currently attacking — this follows Warsow, whose
`INITIAL_ATTACKERS = TEAM_ALPHA` names the alpha *team* as attackers but spawns
them on `team_CTF_betaspawn`. The map data agrees: on wbomb2 the alpha spawns
average ~3400 units from the two sites and beta's ~3800, so alpha is the side
that starts nearer.

The bomb starts each round where the attackers spawn, dropped to the floor.

## Loadouts

Search & Destroy is a loadout mode. You pick a kit; it applies from the **next**
round, so the 10-second freeze is long enough for what you chose to be in your
hands.

Every kit is **blade + one primary + one secondary**:

| Slot | Choices |
|------|---------|
| **Primary** (heavy) | Rocket Launcher, Voltaic, Electrobolt |
| **Secondary** (utility) | Riotgun, Plasma Gun, Grenade Launcher, Machinegun |

Default for a player who has never chosen: **Rocket Launcher + Machinegun**.

Spawn ammo comes from Warsow's `player.as` — RL 15, EB 15, Voltaic 180,
Riotgun 15, Plasma 140, GL 10, MG 150 — plus full spawn armor. Enough to fight a
round with, not enough to stop caring about the map: an empty rocket launcher is
a reason to go somewhere dangerous.

Unlike Warsow Bomb, **map items still spawn.** The kit decides what you can do
from spawn; the map decides what you can do if you take ground.

Pick a kit from the HUD's loadout picker during the freeze, or from the console:

```
loadout rlauncher machinegun
loadout voltaic riotgun
```

## Friendly Fire

Friendly fire is **on**. That is why there are three seconds of team spawn
protection at the start of each round — a mistimed rocket at the spawn would
otherwise end a teammate's whole round before they had moved.

## Maps

Bomb maps are the `wbomb*` set. A map qualifies if it has bomb sites *and* team
spawns; some maps carry site markers but no team spawns and are not playable in
this mode. Site geometry is read from the BSP: authored `trigger_capture_area`
volumes where they exist (wbomb1/5/6), and a radius around the site indicator
where they do not (wbomb2/3/4).

## HUD

Search & Destroy adds its own HUD elements:

- **Bomb objective** — bomb state (carried / dropped / planted / armed),
  in its own corner, left-aligned.
- **Arm/defuse bar** — belongs to whoever is currently on the bomb, attacker or
  defender.
- **Round timer and team scores** — the round clock, not a match clock.
- **Site markers** — the two sites are marked in the world.
- **Phase messages** — freeze, round start, round result.

There is no countdown number during the freeze; the beep is the clock.

## Bots

Bots play Search & Destroy, but they contain no S&D code. The mode steers them
through **agent directives** — plain data the server publishes each snapshot
saying "fetch the bomb", "arm at site B", "defuse", "escort the carrier", "hold
a site", each with a priority. The Bot Intelligence Server acts on whatever it is
handed without knowing what a bomb is.

Defenders retain their site assignments while the living team remains balanced,
and rotate surplus defenders when casualties leave an uneven split. Carrying
the bomb does not give every defender a carrier-hunting order. Plant/defuse work
marked non-interruptible takes precedence over ordinary combat, chasing and
item shopping; defenders still engage visible enemies during normal site defense.
On reaching a defend or hold area, bots patrol nearby supported standing points
inside the assigned radius, pausing briefly between moves. They hold position
when no safe walking segment exists. Planting, arming and defusing orders remain
stationary on arrival.

## Selecting the Gametype

Through the lobby, queue for a Search & Destroy match. For developer flows:

```
map washoi_snd1 snd
```

Or run a dedicated server directly:

```bash
npm run net:server -- --map wbomb1 --gametype SnD
```

## See Also

- [Gametypes overview](./index.md)
- [Weapons](../player/weapons.md) — what each loadout choice does
- [HUD](../player/hud.md) — reading the bomb objective and arm bar
- The design notes, map survey and Warsow source this was ported from:
  `docs/research/Search_And_Destroy.md` in the engine repo
