# Introduction

**Washiki Washoi** is an arena FPS built on the SHAG Engine. The design pulls from Quake 3 and Warsow: high-speed movement, weapon-specific knockback, server-authoritative everything.

## Heritage

- **Q3-style core movement** — air strafing, bunny hopping, friction-driven ground deceleration.
- **Warsow-extended mechanics** — wall jump with charge boost, ledge grab + pull-up, crouchslide with speed bonus.
- **Q3 weapon family** — blade (melee + charged projectile), riotgun, grenade launcher, rocket launcher, plasma gun, machinegun, voltaic, electrobolt, instagun.
- **Server-authoritative netcode** — 125 Hz tick rate, client prediction + reconciliation, snapshot interpolation for remote players, lag compensation for hit detection.

## What's In Right Now

| Area | Status |
|------|--------|
| Movement | Strafe / bunny hop / wall jump (charge + boost) / ledge grab / crouchslide all in |
| Gametypes | Duel (1v1, 10 min), Deathmatch (20 frags / 10 min), Team Deathmatch (50 frags / 15 min) |
| Weapons | Nine weapons defined; balance still evolving |
| Bots | Separate Bot Intelligence Server process, 4 difficulty tiers, BSP vision + NavGraph A*, optional TensorFlow.js dual-network brain |
| Demos | Server-side recording (`.shagdemo` binary), lobby demo list, in-game playback (normal + cinematic) |
| Networking | Dedicated server (WebSocket / WebTransport), client prediction, snapshot interpolation, NetGraph |
| HUD | Health / armor / ammo, kill feed, damage numbers, weapon slots, NetGraph |

## What's Coming

| Area | Notes |
|------|-------|
| CTF | Flag entities, scoring, team capture rules |
| Scoreboard | Full match-summary UI |
| NavGraph reach kinds | Jump pads, teleporters routed in pathfinding |
| Neural-net match training | Training pipeline from recorded demos |

## Next

- [Getting Started](../getting-started/) — set the game up and run it
- [Player Manual](../player/) — controls, movement, weapons
- [Developer](../developer/) — architecture, extending the game
