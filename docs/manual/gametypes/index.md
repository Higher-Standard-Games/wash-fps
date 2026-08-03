# Gametypes

Washiki Washoi ships four gametypes today. All are server-authoritative and configured via the `GametypeController` framework in `server/gametypes/`.

| Gametype | Players | Score limit | Time limit | Notes |
|----------|---------|------------:|-----------:|-------|
| **[Duel](./duel.md)** | 1 v 1 | none (frag-only wins) | 10 min | Stricter pickup respawn timers; spectators allowed; overtime on a draw |
| **[Deathmatch](./deathmatch.md)** (FFA) | up to 16 | 20 frags | 10 min | Classic free-for-all |
| **[Team Deathmatch](./team-deathmatch.md)** | up to 16, two teams | 50 frags total | 15 min | Friendly-fire toggleable |
| **[Search & Destroy](./search-and-destroy.md)** | two teams | 10 rounds (2-round lead) | 90 s per round | Bomb/defuse, no respawns in a round, loadouts, `wbomb*` maps only |

CTF and other team modes are tracked in [introduction → what's coming](../introduction/index.md#whats-coming).

## Selecting a Gametype

Players don't pick gametypes directly — the lobby's matchmaker offers ready matches and you queue for one. For developer flows, the engine's `map <name> [gametype]` command accepts a gametype keyword:

```
map wdm2 duel
map wdm2 dm        # alias for deathmatch / ffa
map wdm2 tdm       # alias for team_deathmatch
map wbomb1 snd     # also: bomb, search, search_and_destroy
```

See the engine's Map Launching Guide (`docs/manual/guides/map-launching.md` in the engine repo) for the developer command flow.
