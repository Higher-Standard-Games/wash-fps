# Amphi

1 v 1, first to three rounds, with a kit you pick and live with.

Where Duel is a ten-minute frag race over a whole map's item economy, Amphi is
a small arena and a short round: you and one opponent, no respawns, and a
weapon set you committed to before the round began.

## Rules

| Rule | Default |
|------|---------|
| Players | 2, one per side |
| Rounds to win | 3, by a lead of 1 |
| Round time | 3 minutes |
| Warmup | 2 minutes |
| Countdown | 5 seconds |
| Between rounds | 4 seconds |
| Post-game | 15 seconds |
| Self damage | Full |
| Spawns | Furthest from the opponent |

## Picking a kit

Nobody is seated until they have chosen. Until both players have picked, both
are spectators and the match stays in warmup — so an Amphi match cannot start
by accident while someone is still deciding.

The round starts with the kit you chose. A choice made later takes effect at
the **next** round, never in the middle of a fight, so a kit can be answered
but not swapped away from.

The picker is the same one Search & Destroy uses during its freeze. See
[HUD](../player/hud.md).

## How a round ends

- **Elimination.** Killing the other player ends the round immediately.
- **Time.** At three minutes, whoever has more health *plus* armor left wins
  the round. An exact tie is recorded as a drawn round — neither side scores.
- **Both at once.** If both players die in the same moment, the round is drawn.

A round is never decided while a player is still loading in: nothing counts
until both sides have actually appeared in the world.

## The arena between rounds

Pickups come back at the **next round** rather than on their own clocks, so
holding a small map still means something after the first thirty seconds. The
usual respawn intervals apply within a round — weapons 30 s, armor 25 s, health
20 s, ammo 15 s, mega health 60 s.

## Maps

| Map | Name |
|-----|------|
| `wamphi1` | Amphitheatre |
| `wda1` | Arena One |
| `wda2` | Arena Two |

The lobby only advertises maps that are actually installed, so a room's map
vote may offer fewer than three.

## Ranking

An Amphi match counts for the leaderboard when both players are people. Playing
a bot earns nothing and costs nothing. See the engine manual's account and
result documentation for what a ranked result records.

## Where the rules live

`src/games/fps/server/gametypes/Amphi.ts` is authoritative: the round outcome,
the kit handling and the pickup rules above are all read from it. The lobby
advertises the mode as "1v1, first to three three-minute rounds".
