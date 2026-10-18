# Gametypes

The first release offers four gametypes. All are server-authoritative and configured via the `GametypeController` framework in `server/gametypes/`.

| Gametype | Players | Score limit | Time limit | Notes |
|----------|---------|------------:|-----------:|-------|
| **[Duel](./duel.md)** | 1 v 1 | none (most frags wins) | 10 min | Challengers queue for the second seat; overtime extends by a minute on a draw |
| **[Amphi](./amphi.md)** | 1 v 1 | Best of 3 rounds | 3 min per round | Timed respawns; most frags in the round wins |
| **[Deathmatch](./deathmatch.md)** (FFA) | up to 16 (8 in a lobby room) | 20 frags | 10 min | Classic free-for-all |
| **[Search & Destroy](./search-and-destroy.md)** | up to 10, two teams | 10 rounds (2-round lead) | 90 s per round | Bomb/defuse, no respawns in a round, loadouts, `wbomb*` maps only |


See [Maps](./maps.md) for which maps each mode plays.

## Selecting a Gametype

Players pick a mode on the lobby's Play stage — **Duel, Amphi, FFA or S&D** — and take a room for it. For developer flows and dedicated servers, the engine's `map <name> [gametype]` command accepts a gametype keyword:

```
map washoi_dm2 duel
map washoi_dm2 dm        # alias for deathmatch / ffa
map wbomb1 snd     # also: bomb, search, search_and_destroy
map wamphi1 amphi
```

The dedicated server takes the same set through `--gametype`, where `1v1` is
also accepted for Duel and `bomb` or `searchanddestroy` for Search & Destroy.

See the engine's Map Launching Guide (`docs/manual/guides/map-launching.md` in the engine repo) for the developer command flow.
