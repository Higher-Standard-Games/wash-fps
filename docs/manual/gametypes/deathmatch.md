# Deathmatch (FFA)

Free-for-all frag derby. Up to 16 players, everyone for themselves.

## Rules

| Rule | Default |
|------|---------|
| Players | up to 16 |
| Score limit | 20 frags — first to 20 wins |
| Time limit | 10 minutes — highest frag count wins at time-up |
| Self-fragging | -1 from score |
| Friendly fire | N/A (no teams) |

## TODO

This page is a stub. Full coverage to come:

- Pickup respawn timing in DM
- Spawn point selection (anti-spawn-camp logic)
- Server commands available to ops
- Aliases: `dm`, `ffa`, `deathmatch` all resolve to this gametype

For now, see `src/games/fps/server/gametypes/Deathmatch.ts` for the authoritative rules.
