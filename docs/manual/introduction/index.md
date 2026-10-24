# Introduction

**Washiki Washoi** is an arena FPS built on the SHAG Engine. The design pulls from Quake 3 and Warsow: high-speed movement, weapon-specific knockback, server-authoritative everything.

## Heritage

- **Q3-style core movement** — air strafing, bunny hopping, friction-driven ground deceleration.
- **Warsow-extended mechanics** — wall jump with charge boost, ledge grab + pull-up, crouchslide with speed bonus.
- **A world that moves and floods** — ladders, swimmable water with drowning, slime and lava, and lifts and doors that carry you and crush you.
- **Q3 weapon family** — blade (melee + charged projectile), riotgun, grenade launcher, rocket launcher, plasma gun, machinegun, voltaic, electrobolt.
- **Server-authoritative netcode** — 125 Hz tick rate, client prediction + reconciliation, snapshot interpolation for remote players, lag compensation for hit detection.

## What's In Right Now

| Area | Status |
|------|--------|
| Movement | Strafe / bunny hop / wall jump (charge + boost) / ledge grab / crouchslide, plus ladders, swimming and moving platforms |
| Map triggers | **Teleporters** (momentum-carrying, telefrag) and **jumppads** — client-predicted, with washoi VFX |
| Fall damage | Floor-to-floor bands, crouch-soften, server-tunable (`sv_falldamage*`) |
| Gametypes | Duel (1v1, 10 min, overtime on a draw), Amphi (1v1 best-of-three rounds with a chosen kit), FFA / Deathmatch (20 frags / 10 min), Search & Destroy (bomb/defuse rounds, `wbomb*` maps) |
| Weapons | Eight weapons; clip/pool/none reload models, Voltaic chain-lightning, blade step-in dash, and a click-then-trade swap away from an empty gun |
| Loadouts | Search & Destroy and Amphi spawn kits — blade + one primary + one secondary, chosen per round |
| Pickups | Server-authoritative active-set; CoD-style plate armor; health tiers with mega overheal; timed powerups |
| Chat | Global (**T** / Enter) and team (**Y**) chat, scrollable history, per-match `/mute` and `/unmute`, recorded into demos |
| Bots | Separate Bot Intelligence Server process, 4 difficulty tiers, BSP vision + NavGraph A*, optional TensorFlow.js dual-network brain |
| Demos | Server-side recording (`.shagdemo` binary), lobby demo list, in-game playback (normal + cinematic), deterministic re-sim verification |
| Lobby | Portable account keys; Public and Private rooms with map votes and chat; bots in Private rooms; independent skill ladders, gameplay stats and match history |
| Spectating | Fly free or follow a player and see what they see; drop into a match under way while it has room |
| Netcode | Dedicated server, fixed-rate authoritative physics (1 dt/tick), client prediction + reconciliation, lag-compensated hits, snapshot baselines, seats held through a dropped connection, input sanitizer, log-only anti-cheat telemetry |
| UI | Washoi manga print-slab HUD, the lobby's gold-rail screens (lobby, settings, leaderboard, profile, demos), match menu, loading and join screens |

## What's Coming {#whats-coming}

| Area | Notes |
|------|-------|
| Anti-cheat enforcement | Detection substrate is in and log-only; gating waits on calibration |

## Next

- [Glossary](./glossary.md) — the terms this manual uses

- [Getting Started](../getting-started/) — set the game up and run it
- [Player Manual](../player/) — controls, movement, weapons
- [Developer](../developer/) — architecture, extending the game
