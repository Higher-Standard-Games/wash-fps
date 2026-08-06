# HUD

The heads-up display. Everything you need to read at a glance during a fight.

The HUD (and the whole front-end) uses the **"Washoi" manga print-slab** look — dark-navy panels with cyan/magenta/gold neon accents, halftone scanlines, hard offset shadows, and stamped labels. Health/armor/ammo render as print-slab vitals; the same visual language runs through the ESC menu, lobby, and ready-room.

## Default Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  [Kill feed]                                              [NetGraph] │
│                                                                  │
│                                                                  │
│                                                                  │
│  [Weapon                          ✛                              │
│   Rack]                       (crosshair)                        │
│                                                                  │
│                                                                  │
│                                                                  │
│                                                                  │
│  [Combat State]                                                  │
│  HP/Armor                                       [Ammo Counter]   │
└──────────────────────────────────────────────────────────────────┘
```

The exact positioning is configurable via cvars; the elements below are the canonical defaults.

## Weapon Rack (left edge)

Vertical list of weapon slots, 1 through 9. Each slot shows:

- The weapon's two-letter tag (BL, MG, RG, GL, RL, PG, VT, EB, IG).
- Highlighted if you own the weapon.
- Brighter highlight if it's your *currently equipped* weapon.
- Ammo count below the tag (or `∞` for the Blade).
- Greyed out if you don't own the weapon.

Press the slot number (1–9) to switch, or scroll wheel to cycle through owned weapons, or Q to quick-switch to your previous weapon.

## Combat State (bottom-left)

Two horizontal bars:

- **HP** — 0 to 100 normally, can exceed via mega health pickups. Red when low.
- **Armor** — 0 to maximum (varies by armor type). The armor takes incoming damage at a configurable ratio; HP only drops after armor is exhausted (or for damage types that bypass armor).

When the server tells the client you've died, the combat state UI tints heavily, the camera lock-freezes at your death position, and the respawn prompt appears in the centre of the screen.

## Ammo Counter (bottom-right)

Large readout of the currently equipped weapon's ammo. The number reflects the *ammo pool* for that weapon's ammo type — so if you're holding the rocket launcher and pick up a different `rockets` pickup elsewhere, both update simultaneously.

Format:

```
ROCKETS
   42
```

Goes red when below the per-weapon "low ammo" threshold.

## Crosshair (centre)

Per-weapon style. Configurable via cvars:

| Cvar | Effect |
|------|--------|
| `cg_crosshair` | Crosshair style |
| `cg_crosshairSize` | Size in pixels |
| `cg_crosshairColor` | Hex color string |
| `cg_crosshairAlpha` | Opacity (0–1) |
| `cg_crosshairSpread` | Spread response (widens with movement / narrows under ADS) |
| `cg_crosshairDmgColor` | Color flash on confirmed hit (default `FF0000`) |

The crosshair briefly flashes to `cg_crosshairDmgColor` for ~200 ms when your shot deals damage — this is a server-confirmed hit indicator, not a client-side guess.

## Chat (bottom-left)

Recent chat messages float here and fade after ~8 seconds. Press **T** to talk — the panel expands into a scrollable history dialog. See [In-Game Chat](../multiplayer/chat.md).

## Event Feed / Kill Feed (top-right)

Recent kills, last ~5 lines:

```
PlayerA  ⚒  PlayerB
PlayerC  →[RL]→  PlayerD
PlayerE  💀  (self)
```

The middle glyph is the weapon used. Some special icons:

- `⚒` — melee kill (Blade swing).
- `💀` — environmental / self-damage / falling.
- `(self)` — self-frag (lost a frag from your score).

## Damage Numbers (floating)

When you damage someone, a number floats up from their position briefly. Numbers stack (multiple hits add together visually) and turn yellow above 50 damage.

The damage value shown is the server-authoritative damage your shot dealt — not your client's estimate.

Damage numbers are **not** cvar-driven — lifetime (1.5 s), float speed, colours and the 50-damage highlight threshold are module constants at the top of `src/games/fps/client/DamageNumbers.ts`.

## NetGraph (top-right, optional)

Connection diagnostics. Three modes via `cl_netgraph`:

| Mode | What you see |
|------|--------------|
| 0 | Off |
| 1 | Text overlay: ping, snapshot rate, packet loss %, interp delay, command rate |
| 2 | Mode 1 + a rolling graph of the same metrics |

Read the Engine Networking Guide (`docs/manual/guides/networking.md` in the engine repo) for what each number means and what's an acceptable range.

## Match State

Elements that appear when the match, rather than the fight, needs your
attention:

| Element | When it shows |
|---------|---------------|
| **Timer** | Always in a timed match — round clock in Search & Destroy, match clock elsewhere |
| **Gametype badge** | The mode you are in |
| **Scoreboard** | Held **Tab**, and automatically at match end |
| **Frag counter / frag message** | Your score, and the confirmation when you take one |
| **Ready bar** | Warmup — who is ready, and how many are still needed |
| **Phase message** | Warmup, countdown, round start, round result, match end |
| **Round result** | End-of-round banner (Search & Destroy) |
| **Death screen** | On death — who killed you, with what, and the respawn state |
| **Pause menu** | Escape, mid-match |

## Powerup Timer

When you are carrying a timed powerup, a countdown appears with the remaining
duration. Powerups are server-tracked; the timer is a read of authoritative
state, not a local guess. See
[Pickups & Inventory](./pickups-and-inventory.md#powerups).

## Search & Destroy HUD

Search & Destroy adds objective elements. See
[the gametype page](../gametypes/search-and-destroy.md) for the rules behind
them.

| Element | Behaviour |
|---------|-----------|
| **Bomb objective** | Bomb state — carried, dropped, planted, armed — in its own corner, left-aligned |
| **Arm / defuse bar** | Belongs to whoever is currently working the bomb, attacker or defender |
| **Bomb site markers** | The two sites, marked in the world |
| **Team scores** | Rounds won by each side |
| **Loadout picker** | During the freeze — pick your primary and secondary for the next round |

There is no countdown number during the round freeze. The bomb beep is the
shared clock, and both teams hear it at the same time.

## Ammo Warning & Pickup Toast

- **Ammo warning** — fires when the equipped weapon drops below its low-ammo
  threshold, before the counter alone would register.
- **Pickup toast** — a brief confirmation of what you just picked up, paired
  with the pickup sound.

## Settings Overlay

Press **Escape** mid-match to open the in-game settings overlay. Four tabs:

- **Graphics** — fullscreen, bloom intensity, anisotropy.
- **Audio** — music volume, effects volume.
- **Controls** — full keyboard + mouse rebind UI with a virtual keyboard.
- **Interface** — crosshair, HUD, NetGraph.

The same settings are accessible from the lobby's Settings tab (the lobby and the in-game overlay mount the same `FPSSettingsView`).

## Pickup Prompt (centre, when active)

A single-line overlay appears below the crosshair when you walk over a weapon pickup that needs a manual confirmation (see [Pickups & Inventory](./pickups-and-inventory.md)):

```
PRESS [F] TO SWAP TO ROCKET LAUNCHER
```

The prompt is suppressed in spectator / freefly mode and when the pointer isn't locked.

## See Also

- [Movement](./movement.md) — how movement state affects view bob and FOV
- [Weapons](./weapons.md) — per-weapon HUD details
- [Pickups & Inventory](./pickups-and-inventory.md) — powerups and the pickup toast
- [Search & Destroy](../gametypes/search-and-destroy.md) — the bomb objective and loadout picker
- [Multiplayer → Connecting](../multiplayer/connecting.md) — reading NetGraph during a match
