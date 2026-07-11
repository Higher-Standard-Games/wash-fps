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
| `cg_crosshairSize` | Size in pixels |
| `cg_crosshairColor` | Hex color string |
| `cg_crosshairAlpha` | Opacity (0–1) |
| `cg_crosshairHitColor` | Color flash on confirmed hit |

The crosshair briefly flashes to `cg_crosshairHitColor` when your shot deals damage — this is a server-confirmed hit indicator, not a client-side guess.

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

When you damage someone, a number floats up from their position briefly. Numbers stack (multiple hits add together visually). Cvars:

| Cvar | Effect |
|------|--------|
| `cl_damagenumbers` | 0 / 1 toggle |
| `cl_damagenumbers_scale` | Size multiplier |
| `cl_damagenumbers_duration` | Fade duration in seconds |

The damage value shown is the server-authoritative damage your shot dealt — not your client's estimate.

## NetGraph (top-right, optional)

Connection diagnostics. Three modes via `cl_netgraph`:

| Mode | What you see |
|------|--------------|
| 0 | Off |
| 1 | Text overlay: ping, snapshot rate, packet loss %, interp delay, command rate |
| 2 | Mode 1 + a rolling graph of the same metrics |

Read the [Engine Networking Guide](../../../../../docs/manual/guides/networking.md) for what each number means and what's an acceptable range.

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
- [Multiplayer → Connecting](../multiplayer/connecting.md) — reading NetGraph during a match
