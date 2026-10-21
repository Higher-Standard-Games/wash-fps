# Lobby, Rooms and Accounts

The lobby is the game's front door: it knows who you are, finds you a room, starts the match and keeps your record. This page covers the parts that live around the match. For the step-by-step flow into a game, see [Connecting](./connecting.md).

## The lobby screen

The gold rail on the left is the whole menu:

| Key | What it opens |
|-----|---------------|
| **Play** | The mode stage: Duel, Amphi, FFA, S&D. Pick one and find a room. FFA rooms hold 8 players, S&D rooms 10 (it starts from 2), Duel and Amphi 2 |
| **Leaderboard** | Skill rankings per mode, with separate Public and Private pools |
| **Demos** | Replays of recorded matches; see [Demos](./demos.md) |
| **Profile** | Your account and your ranked record |
| **Settings** | The settings screen; see [HUD → Settings](../player/hud.md#settings-overlay) |
| **Console** | The developer console |

Below the keys the rail shows your name, and while you are on the Play stage it lists the rooms you can join and the room's chat.

## Accounts

### Welcome guide

After initial loading and account setup, a yellow welcome dialog introduces Washoi
and shows the [terms of service](https://github.com/Higher-Standard-Games/wash-fps/blob/main/TERMS.md)
in a scrolling box. Tick **I agree to the terms of service** to go on: until
then **Next »**, the other tabs and Escape do nothing, and the guide opens even
if it was set not to show again. Agreeing is remembered in this browser; new
terms ask again.

The next tabs show your current keyboard and mouse bindings and explain
crouchsliding and wall jumping. **Next »** advances through the three tabs;
**Close** or Escape returns to the lobby. The background stays blurred and inactive while it is open.

**Go to keyboard setup** opens Controls. **Back to welcome**, or leaving Settings,
returns to the guide with your updated bindings. On the last tab, **Don't show
this again** saves a preference in this browser. The **?** button in the lobby's
bottom-right footer on the main **Play** page reopens the guide even when automatic display is disabled.
Match rooms and other lobby pages hide the button and reclaim its footer space.
Uncheck the preference there to enable it on future page loads.

### Credits

**CREDITS**, beside the **?** button on the **Play** page, opens the credits and
copyrights: the team, the libraries and fonts the game uses, and where its
weapons, sounds, player model and maps come from, with their licences. It shows
`CREDITS.md` from the root of this repository, the same file GitHub shows, so
edit that file to change the credits. **Close**, Escape or a click outside closes it.
The game version, such as `v0.9.37`, is shown just left of **CREDITS**, and
**DEVLOG** between them opens washoi.net/devlog in a new browser tab.

The guide appears once per client startup, not when returning from a match.
Invite links continue after you close it. Its movement tips use standard rules;
individual servers may configure movement differently.

### Your identity

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
- **Pick a side** in a team mode, add **bots in private rooms**, and **chat** with the room.
- **Ready up.** When everyone is ready the lobby starts a dedicated game server for that match alone and hands your client a ticket for your seat.

See [Connecting → In the Ready Room](./connecting.md#in-the-ready-room) for the voting and bot rules.

When a match ends, **Back to the lobby** returns you to the same room, ready for a rematch.

### Joining a match that has started

A room whose match is under way shows **join** if it has space and **watch** if it is full. See [Connecting → Joining a match under way](./connecting.md#joining-a-match-under-way).

## Ranked matches

**Match records and skill ratings are separate.** A recorded match can contribute
gameplay totals and history without changing your rating. Profile history shows
whether it was rated and explains exclusions.

| Pool | What counts toward its rating |
|------|------------------------------|
| **Public** | Eligible matches between verified human accounts; public rooms do not allow bots |
| **Private** | Eligible human matches and matches against verified standard bot presets |

Ratings are separate for each mode and pool. The system uses **TrueSkill**, which
tracks both estimated skill and uncertainty, rather than a win-count ladder or
classic Elo. Your displayed rating is a conservative estimate. It is marked
**Provisional** until you have at least 10 rated matches and uncertainty is low
enough; provisional players can appear after their first rated match.

The original roster, final standings and full-match participation must be
verifiable. Late joins, side changes, interrupted participation and aborted
matches can prevent a rating update. A supported 1v1 forfeit can still be rated.
Custom bot configurations, unverified presets or bot configuration changes do not
qualify. Standard preset bots have their own rating identities; playing them is
not automatically an unrated practice session. The bots are rated but not listed:
the leaderboard shows people only, ranked among themselves.

Participation is tied to the verified account through its seat ticket, not its
display name. A direct server connection does not by itself guarantee a lobby
record or rating. Check Profile history for the stored decision.

## Leaderboard

Pick a mode and see its ranking:

- **Public / Private**: choose which independent ladder to read.
- **30 days / All time**: choose the activity window; 30 days rolls continuously.
- **Top 100**: the whole list, with a search.

The top players are shown as a podium, and your own rank in every mode appears in
the rail. Players are ordered by conservative skill rating; wins, losses, draws,
games and win rate provide context. The 30-day view filters recent activity; it
does not reset your skill rating every month. Public and private positions can
differ, and an unrated account has no ladder position yet.

## Profile

Profile shows your name and key, plus per-mode records for the selected Public or
Private pool. It includes skill rating, provisional status, gameplay totals and
match history, with rating changes or an explanation when a match was not rated.
It is also where you rename yourself or switch accounts.

## Where this lives

The lobby server, accounts and the result store are part of the engine (`src/lobby/` in the engine repo); the screens are in this repo's `client/` (`LobbyPanel.ts`, `ProfileView.ts`, `LeaderboardView.ts`, `WelcomeOverlay.ts`).
