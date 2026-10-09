# Duel

1 v 1 arena play, the classic competitive format: one map, two players, ten minutes, most frags wins.

For short best-of-three rounds in a small arena, see [Amphi](./amphi.md).

## Rules

| Rule | Default |
|------|---------|
| Players | 2 (everyone else spectates) |
| Score limit | None; the clock decides |
| Time limit | 10 minutes |
| Win condition | More frags when time is up |
| Tied at time-up | Overtime: +1 minute, repeated until someone leads. A duel never ends in a draw |
| Warmup | Up to 2 minutes, ends when both players are ready |
| Countdown | 3 seconds |
| Player respawn | 3 s minimum before you can respawn, 6 s automatic |
| Post-game | 18 seconds on the result screen |
| Self damage | Full |
| Spawns | Furthest from the opponent |
| Loadout | Blade only; everything else comes from the map |

A kill is +1 frag. Killing yourself (a fall, your own rocket, lava) costs 1 frag.

## Items

Duel plays on the full item economy of the map and uses the standard pickup timers: weapons 15 s, ammo 15 s, armor 25 s, health 20 s, mega health 60 s. Armor and mega health are absent for the first 15 seconds of a match. See [Pickups & Inventory](../player/pickups-and-inventory.md#pickup-respawn).

Because you spawn with only the Blade, **map control is the game**: who holds the armor, mega health and Quad Damage timers, and who denies the other player weapons, usually wins.

## Joining a duel

The match holds two players. Anyone else who joins becomes a spectator and waits in the **challengers queue**, first come first served. When a player leaves or disconnects, the next challenger is promoted into the free slot. A player who drops mid-match keeps their seat for a short time so they can reconnect; see [Connecting](../multiplayer/connecting.md).

A match already under way takes new players while it has room, so you can drop into a duel that only has one player in it.

## Spectating

Spectators can fly free or follow either player, and see exactly what the player they follow sees. See [HUD → Spectating](../player/hud.md#spectating).

## Ranking

A Duel counts for the leaderboard when both players are people. See [Lobby, Rooms and Accounts](../multiplayer/lobby.md).

## Where the rules live

`server/gametypes/Duel.ts` is authoritative. Overtime and the other shared timers are in `MatchState.ts`.
