# Gametypes

Washiki Washoi ships three gametypes today. All are server-authoritative and configured via the `GametypeController` framework in `server/gametypes/`.

| Gametype | Players | Score limit | Time limit | Notes |
|----------|---------|------------:|-----------:|-------|
| **[Duel](./duel.md)** | 1 v 1 | none (frag-only wins) | 10 min | Stricter pickup respawn timers; spectators allowed |
| **[Deathmatch](./deathmatch.md)** (FFA) | up to 16 | 20 frags | 10 min | Classic free-for-all |
| **[Team Deathmatch](./team-deathmatch.md)** | up to 16, two teams | 50 frags total | 15 min | Friendly-fire toggleable |

CTF and other team modes are tracked in [introduction → what's coming](../introduction/index.md#whats-coming).

## Selecting a Gametype

Players don't pick gametypes directly — the lobby's matchmaker offers ready matches and you queue for one. For developer flows, the engine's `map <name> [gametype]` command accepts a gametype keyword:

```
map wdm2 duel
map wdm2 dm        # alias for deathmatch / ffa
map wdm2 tdm       # alias for team_deathmatch
```

See the engine's [Map Launching Guide](../../../../../docs/manual/guides/map-launching.md) for the developer command flow.
