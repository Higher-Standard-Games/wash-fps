# Match Flow and Screens

What you see from the moment a match is found to the result screen, and how to read the scoreboard.

## The phases of a match

The server moves every match through the same phases. A banner in the middle of the screen tells you which one you are in.

| Phase | What you see | What is happening |
|-------|--------------|-------------------|
| **Warmup** | **Warmup**, the mode's name, and **Press F4 to ready up** (then **Waiting for others…**). The ready bar shows who is ready | Free-fighting with no scoring. Players, items and bots are all live. The match starts when everyone is ready, or when the warmup times out |
| **Countdown** | The numbers **3, 2, 1** | Everyone is spawned and held in place. In a round mode this is the **freeze** before each round, which is when you pick a kit and which has no number |
| **Active** | **Fight!** for two seconds, then the timer | The match is live. Frags score, items respawn, win conditions apply |
| **Round end** | A banner with the result, in the round modes only | Nobody can move or shoot while the result shows. See below |
| **Post-game** | **`<name>` wins!** or **Draw!**, then the result screen | The match is over |

How long each phase lasts depends on the mode: see the rules table on each [gametype page](../gametypes/index.md).

### Round results

In Search & Destroy a banner names how the round ended, and who won it:

| Banner | Meaning |
|--------|---------|
| **Bomb defused** | The defenders won |
| **Bomb detonated** | The attackers won. The explosion plays out before the banner appears |
| **Time up** | The round timer ran out, which is a defender win |

In Amphi and any other round mode the banner is simply **`<name>` wins the round**, and the scoreboard's team headers carry the rounds won.

## The scoreboard

Hold **Tab** to see it. It also appears on its own at the end of a match. While the match menu is open, Tab moves between the menu's keys instead.

- **Free-for-all and Duel:** one list with **Player**, **Score**, **Deaths** and **Ping**.
- **Team modes:** two columns, **Team Soba on the left and Team Udon on the right**, with **Player**, **Score** and **Ping** for each. The team's score is in its header: frags in Team Deathmatch, **rounds won** in a round mode. In a round mode the round number sits above the columns.
- **Your row** is highlighted. Your own side is drawn in your ally colour and the other in your enemy colour, whichever side you are on; see [Settings](./settings.md).
- **Search & Destroy:** a marker next to a name shows who is **carrying the bomb**.
- **Players who left** stay in the list, dimmed, with **LEFT** where their ping was, so a match's final scores still add up.
- **Spectators** are listed under the table as **Spectators (n)**.

## The result screen

When a match ends, the scoreboard locks open and is titled with the result. The winner's player model stands in front of the camera, holding the weapon they last carried, in the left third of the screen. A panel beside it lists the winner's **Frags**, **Deaths** and **K/D**.

The bottom of the screen tells you what happens next:

- On a **lobby-hosted** match (every match started from the lobby), the server is finished. The message reads **GG — return to lobby for the next one**, and **Back to the lobby** returns you to the same room, ready for a rematch.
- On a **dedicated server** that keeps running, it reads **Match over — next match starting soon…** and the next warmup begins.

A match counts toward the [leaderboard](../multiplayer/lobby.md#ranked-matches) only if it was ranked.

## Loading and joining

When the lobby starts your match, the connecting screen becomes the loading screen: a bar fills while the map loads, and the stage names the map. Then the game fades in and you spawn. See [Connecting](../multiplayer/connecting.md) for the steps, and [HUD → Join screen](./hud.md#join-screen) if you reached a server by `connect`.

## See also

- [HUD](./hud.md) — everything else on screen
- [Gametypes](../gametypes/index.md) — each mode's timers and scoring
