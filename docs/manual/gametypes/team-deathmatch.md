# Team Deathmatch

Two teams, **Udon** and **Soba**. Every frag adds to your team's total.

::: warning Not in the lobby yet
The lobby's Play stage offers Duel, Amphi, FFA and S&D only. Team Deathmatch is reached with `map <name> tdm` from the console or a dedicated server started with `--gametype tdm`.
:::

## Rules

| Rule | Default |
|------|---------|
| Players | Up to 16, split across the two teams |
| Score limit | 50 team frags; the first team to reach it wins |
| Time limit | 15 minutes; the higher team score wins at time-up |
| Tied at time-up | A draw |
| Warmup | Up to 2 minutes |
| Countdown | 3 seconds |
| Player respawn | 3 s minimum before you can respawn, 6 s automatic |
| Post-game | 15 seconds on the result screen |
| Self damage | Full |
| Spawns | Furthest from other players (there are no team-specific spawns) |
| Loadout | Blade only; everything else comes from the map |

## Scoring

| Event | Team score | Your score |
|-------|-----------:|-----------:|
| You frag an enemy | +1 | +1 |
| You frag a teammate | −1 | −1 |
| You kill yourself | −1 | −1 |

## Friendly fire

Friendly fire is **always on**. Your rockets, grenades and splash hurt your teammates, and killing one costs your team a frag. It is not a server toggle in this version, so mind your splash in tight spaces.

## Teams and balance

- **Joining.** You are placed on the smaller team. Ties go to Udon.
- **Choosing a side.** If you ask for a specific team through the lobby or the match menu's **Join Udon** / **Join Soba** keys and that team is the bigger one, you are put on the smaller one instead. The key says how many players each side has.
- **Colours.** Your team and enemies are coloured by your own settings; see [HUD → Settings](../player/hud.md#settings-overlay).

## Team play with bots

When bots fill a team, a bot that strays more than 1,200 units from the rest of its team gets a low-priority order to regroup. It still decides for itself whether the Red Armor next to it is worth more than regrouping. See [Bot Intelligence Server](../tools/bot-server.md).

## Aliases

`tdm`, `team`, `team_deathmatch` and `teamdeathmatch` resolve to this gametype.

## Where the rules live

`server/gametypes/TeamDeathmatch.ts`; scoring and team balance are in `GametypeController.ts` and `MatchState.ts`.
