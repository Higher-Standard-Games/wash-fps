# Player Manual

How to play. Read in order if you're new to Q3/Warsow-style arena shooters; jump around if you're not.

| Page | Covers |
|------|--------|
| [Your First Match](./first-match.md) | A walkthrough for new players: from the lobby to your first frag |
| [Movement](./movement.md) | Strafe / bunny hop / wall jump / ledge grab / crouchslide / ladders / water / lifts |
| [Weapons](./weapons.md) | Every weapon's damage, fire rate, ammo, splash, niche |
| [Pickups & Inventory](./pickups-and-inventory.md) | Slot mechanics, swap prompt, ammo + health + armor |
| [HUD](./hud.md) | Reading the heads-up display |
| [Match Flow and Screens](./screens.md) | Warmup to result screen, the scoreboard, round results |
| [Damage and Combat Rules](./combat.md) | Hit locations, armor, splash falloff, knockback, self damage |
| [Settings](./settings.md) | Controls, crosshair, team colours, video presets, audio, and console-only variables |

## Controls (default)

| Key | Action |
|-----|--------|
| W / A / S / D | Move |
| Mouse | Aim |
| Space | Jump (hold for bunny hop); fly up while spectating |
| Ctrl / C / Mouse 3 | Crouch (crouch while running fast = slide) |
| Shift | Walk (with **Always run** on, the default) or run (off); fly down while spectating |
| Mouse 1 | Primary fire |
| Mouse 2 | Aim-down-sights (where supported) |
| 1–9 | Switch weapon slot |
| Mouse wheel | Next / previous weapon |
| Q | Blade (second key for slot 1) |
| F | Pickup / interact |
| R | Reload (where applicable) |
| Tab | Scoreboard (hold) |
| T or Enter | Global chat |
| Y | Team chat |
| F4 | Ready up (warmup) |
| J | Join game (while spectating) |
| ` (backquote) | Open console |

Movement and combat keys are rebindable in **Settings → Controls** or through
`bind`. Menu, scoreboard, chat, console and join keys are fixed. See [Settings](./settings.md).

## A note on physics

Movement uses the same `FPSSimulation` on the client and the server. The client *predicts* your motion locally so input feels instant; the server *authoritatively* re-runs the same simulation and corrects you if you drift. The result is responsive movement that's still cheat-resistant. Concretely:

- You will sometimes feel a tiny "snap" when packet loss happens — that's reconciliation. The visual smoother in the engine takes the edge off it.
- The numbers below (jump velocity, slide duration, etc.) are server-authoritative defaults. Some can be overridden by cvars in singleplayer / dev; competitive servers lock them.

See the [Movement](./movement.md) page for the exact values.
