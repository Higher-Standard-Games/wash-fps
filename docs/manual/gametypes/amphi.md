# Amphi

1v1 deathmatch, best of three rounds, with a chosen spawn kit.

Where Duel is a ten-minute frag race over a whole map's item economy, Amphi
plays three short deathmatch rounds in a small arena. Players respawn after
kills and receive their selected weapon set on each spawn.

## Rules

| Rule | Default |
|------|---------|
| Players | 2, one per side |
| Format | Best of 3; first to 2 round wins |
| Round time | 3 minutes |
| Tied round | +1 minute overtime, repeated until one player leads at expiry |
| Warmup | 2 minutes |
| Countdown | 5 seconds |
| Between rounds | 4 seconds |
| Post-game | 15 seconds |
| Player respawn | 2 s minimum, 4 s automatic |
| Self damage | Full |
| Spawns | Furthest from the opponent |

## Picking a kit

Nobody is seated until they have chosen. Until both players have picked, both
are spectators and the match stays in warmup.

The round starts with the kit you chose. A changed selection applies on your
**next spawn**, including a death and respawn within the current round. Changing
the selection does not replace the weapons you are carrying while alive. See
[HUD](../player/hud.md).

## How a round ends

- **Time.** After three minutes, the player with more frags in that round wins.
- **Tie.** Equal frags add one minute of overtime. If the players are still tied
  at the next expiry, another minute is added. The round ends at an expiry when
  one player leads, so each of the three rounds has a winner.
- **Early match end.** A 2-0 lead ends the match after round two.

The scoreboard's frag and death counts reset at the start of each round. Round
wins remain on the match score. Suicides cost one frag, as in normal deathmatch.

## The arena between rounds

Map weapons do not spawn; players use their chosen kits. Other pickups return
on the standard timers within a round: armor 25 s, health 20 s, ammo 15 s,
and mega health 60 s. The map's pickup state also resets for the next round.

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

`src/games/fps/server/gametypes/Amphi.ts` is authoritative for the round
outcome, kit handling, and pickup rules. The lobby advertises the mode as a
best-of-three 1v1 deathmatch.
