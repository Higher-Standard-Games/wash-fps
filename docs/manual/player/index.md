# Player Manual

How to play. Read in order if you're new to Q3/Warsow-style arena shooters; jump around if you're not.

| Page | Covers |
|------|--------|
| [Movement](./movement.md) | Strafe / bunny hop / wall jump / ledge grab / crouchslide |
| [Weapons](./weapons.md) | Every weapon's damage, fire rate, ammo, splash, niche |
| [Pickups & Inventory](./pickups-and-inventory.md) | Slot mechanics, swap prompt, ammo + health + armor |
| [HUD](./hud.md) | Reading the heads-up display |

## Controls (default)

| Key | Action |
|-----|--------|
| W / A / S / D | Move |
| Mouse | Aim |
| Space | Jump (hold for bunny hop) |
| Ctrl | Crouch (release while moving fast = slide) |
| Shift | Run / sprint |
| Mouse 1 | Primary fire |
| Mouse 2 | Aim-down-sights (where supported) |
| 1–9 | Switch weapon slot |
| Q | Quick-switch to previous weapon |
| F | Pickup / interact |
| R | Reload (where applicable) |
| Tab | Scoreboard (hold) |
| ~ / F1 | Open console |

All keys are rebindable in **Settings → Controls** (lobby UI) or via the engine's `bind` command.

## A note on physics

Movement uses the same `FPSSimulation` on the client and the server. The client *predicts* your motion locally so input feels instant; the server *authoritatively* re-runs the same simulation and corrects you if you drift. The result is responsive movement that's still cheat-resistant. Concretely:

- You will sometimes feel a tiny "snap" when packet loss happens — that's reconciliation. The visual smoother in the engine takes the edge off it.
- The numbers below (jump velocity, slide duration, etc.) are server-authoritative defaults. Some can be overridden by cvars in singleplayer / dev; competitive servers lock them.

See the [Movement](./movement.md) page for the exact values.
