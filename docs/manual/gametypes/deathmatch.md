# Deathmatch (FFA)

Free-for-all frag derby. Up to 16 players, everyone for themselves.

## Rules

| Rule | Default |
|------|---------|
| Players | Up to 16 |
| Score limit | 20 frags; the first player to reach it wins |
| Time limit | 10 minutes; most frags at time-up wins |
| Tied at time-up | A draw (only [Duel](./duel.md) plays overtime) |
| Warmup | Up to 2 minutes |
| Countdown | 3 seconds |
| Player respawn | 3 s minimum before you can respawn, 6 s automatic |
| Post-game | 15 seconds on the result screen |
| Self damage | Full |
| Spawns | Furthest from other players |
| Loadout | Blade only; everything else comes from the map |

A kill is +1 frag. Killing yourself costs 1 frag. There are no teams, so there is no friendly fire; the scoreboard lists every player.

## Items

Weapons respawn every 30 s, ammo 15 s, armor 25 s, health 20 s and mega health 60 s. Armor and mega health are absent for the first 15 seconds of a match. The Quad Damage is on the map. See [Pickups & Inventory](../player/pickups-and-inventory.md).

## Joining and spectating

Players can join while a match is under way, as long as there is room. The scoreboard (hold **Tab**) lists players, frags, deaths and ping. While spectating you can follow any player; see [HUD → Spectating](../player/hud.md#spectating).

## Aliases

`ffa`, `dm` and `deathmatch` all resolve to this gametype.

## Tuning for development

A local or dedicated server reads three environment variables once at boot, which is handy for short test matches:

| Variable | Meaning |
|----------|---------|
| `SHAG_TIMELIMIT` | Time limit. A bare number is **minutes**; add `s` for seconds (`90s`) |
| `SHAG_SCORELIMIT` | Score limit, a plain number |
| `SHAG_WARMUP` | Warmup timeout. A bare number is **seconds**; add `m` for minutes |

These apply to every gametype.

## Where the rules live

`server/gametypes/Deathmatch.ts`; scoring is in `GametypeController.ts` and `MatchState.ts`.
