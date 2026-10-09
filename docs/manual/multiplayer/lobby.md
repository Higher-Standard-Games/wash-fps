# Lobby, Rooms and Accounts

The lobby is the game's front door: it knows who you are, finds you a room, starts the match and keeps your record. This page covers the parts that live around the match. For the step-by-step flow into a game, see [Connecting](./connecting.md).

## The lobby screen

The gold rail on the left is the whole menu:

| Key | What it opens |
|-----|---------------|
| **Play** | The mode stage: Duel, Amphi, FFA, S&D. Pick one and find a room. FFA rooms hold 8 players, S&D rooms 10 (it starts from 2), Duel and Amphi 2 |
| **Leaderboard** | Rankings per mode, for the last 30 days or all time |
| **Demos** | Replays of recorded matches; see [Demos](./demos.md) |
| **Profile** | Your account and your ranked record |
| **Settings** | The settings screen; see [HUD → Settings](../player/hud.md#settings-overlay) |
| **Console** | The developer console |

Below the keys the rail shows your name, and while you are on the Play stage it lists the rooms you can join and the room's chat.

## Accounts

You never register. The first time a browser reaches the lobby it makes you an account and asks what to call yourself.

- **Name.** 2–16 characters: letters, numbers, `_` and `-`. Names reserved for bots and new players (the `Player_<number>` style) are refused. Leaving the name empty keeps the one you were given. You can rename later from Profile.
- **Key.** Your account's **key** is 24 characters, shown in groups of four. It is the only thing that proves the account is yours: type it into **Use my key** on the welcome screen, or on Profile, in any other browser and you are signed in as the same player, with the same record.
- **Keep your key safe.** The lobby only ever sees it when you log in, so nobody can recover it for you. Profile has **Copy key** and **Save as file** keys (and, where the browser allows it, **Save in browser**). Anyone who has it can play as you.
- **Switching accounts.** Profile also lets you play as someone else by entering a different key.

The lobby rate-limits account creation, wrong keys and renames per network address, so a burst of attempts will be refused for a while.

## Rooms

Pressing the big action under a mode puts you in a **room** for that mode, either an open one with space or a new one. A **Private** room appears in no list, and the only way in is the invite link it gives you.

In a room you can:

- **Vote for a map.** Three maps are drawn from the mode's pool (only maps actually installed are offered, so there can be fewer than three); the most votes wins.
- **Pick a side** in a team mode, add **bots**, and **chat** with the room.
- **Ready up.** When everyone is ready the lobby starts a dedicated game server for that match alone and hands your client a ticket for your seat.

See [Connecting → In the Ready Room](./connecting.md#in-the-ready-room) for the voting and bot rules.

When a match ends, **Back to the lobby** returns you to the same room, ready for a rematch.

### Joining a match that has started

A room whose match is under way shows **join** if it has space and **watch** if it is full. See [Connecting → Joining a match under way](./connecting.md#joining-a-match-under-way).

## Ranked matches

Results are recorded for **ranked** matches only. Whether a match is ranked is decided from the roster at the moment it starts, and bots never take away a human's result; they only decide whether it counts:

| Mode type | Counts when |
|-----------|-------------|
| **Duel** and **Amphi** (1 v 1) | Both players are people |
| **Team modes** (S&D) | More than half the players are people, and there is at least one person on each side |
| **Free-for-all** | More than half the players are people, and at least two |

A match that is abandoned, or that has too few people, is not ranked. A player's participation is tied to their account through their seat ticket, never to the name they typed.

## Leaderboard

Pick a mode and see its ranking:

- **Last 30 days**: a rolling window that never resets.
- **All time**: since launch.
- **Top 100**: the whole list, with a search.

The top players are shown as a podium, and your own rank in every mode appears in the rail. Players are ordered by **wins**, then fewest **losses**, then most **draws**. The lobby records wins, losses and draws only, so there is no kill/death ratio on the leaderboard; each row also shows games played and win rate.

## Profile

Profile shows your name, your key and your **ranked record** (wins, losses and draws) per mode. It is also where you rename yourself or switch accounts.

## Where this lives

The lobby server, accounts and the result store are part of the engine (`src/lobby/` in the engine repo); the screens are in this repo's `client/` (`LobbyPanel.ts`, `ProfileView.ts`, `LeaderboardView.ts`, `WelcomeOverlay.ts`).
