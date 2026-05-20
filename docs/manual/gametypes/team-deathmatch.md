# Team Deathmatch

Two teams, accumulated frag total decides the winner.

## Rules

| Rule | Default |
|------|---------|
| Players | up to 16, split into 2 teams |
| Score limit | 50 frags (team total) |
| Time limit | 15 minutes |
| Win condition | First team to score limit, or higher team score at time-up |
| Team balance | Auto-balance on join; manual shuffle command available |
| Friendly fire | Server-policy toggle |

## TODO

This page is a stub. Full coverage to come:

- Team assignment + balancing rules
- Friendly fire damage scaling (typically 50% or 0%)
- Spawn point selection (team-specific spawns when available)
- Server commands: `shuffle`, `teamswap`
- Aliases: `tdm`, `team`, `team_deathmatch`, `teamdeathmatch` all resolve to this

For now, see `src/games/fps/server/gametypes/TeamDeathmatch.ts` for the authoritative rules.
