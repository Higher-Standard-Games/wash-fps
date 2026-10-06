# HUD

The heads-up display. Everything you need to read at a glance during a fight.

The HUD uses the **"Washoi" manga print-slab** look — dark-navy panels with cyan/magenta/gold neon accents, halftone scanlines, hard offset shadows, and stamped labels. Health/armor/ammo render as print-slab vitals. The screens that take over from the fight — the loading screen, the join screen, the match menu — wear the lobby's own look instead: its gold rail and raised keys.

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

Press the slot number (1–9) to switch, or scroll wheel to cycle through owned weapons. **Q** is a second key for slot 1, so it always pulls out the Blade.

## Combat State (bottom-left)

Two horizontal bars:

- **HP** — 0 to 100 normally, can exceed via mega health pickups. Red when low.
- **Armor** — 0 to maximum (varies by armor type). The armor takes incoming damage at a configurable ratio; HP only drops after armor is exhausted (or for damage types that bypass armor).

When the server tells the client you've died, the camera lock-freezes at your
death position, the screen darkens in red toward its edges, and the death screen
comes up in the centre: **YOU GOT FRAGGED**, then a card with who fragged you and
how — blown up, railed, melted, gunned down, cut down, telefragged — read from
the damage the server reports, or nobody to blame for a fall or your own blast.
Its bar counts down the three seconds of respawn protection and turns green when
**fire** will respawn you. In a round mode there is no countdown: you are out
until the next round.

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

Recent chat messages float here, just above the health and weapon bar, and fade after ~8 seconds. Lines from the game itself — why a join was refused, your place in the challengers queue, a round to wait for — appear among them in gold, without a name. Press **T** to talk — the panel expands into a scrollable history dialog. See [In-Game Chat](../multiplayer/chat.md).

## Event Feed / Kill Feed (top-left)

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

When you damage someone, a number floats up from their position briefly. Numbers stack (multiple hits add together visually) and turn yellow at 50 damage or more.

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
| **Timer** | Always in a timed match — a round clock in the round-based modes, Search & Destroy and Amphi, and a match clock elsewhere |
| **Gametype badge** | The mode you are in |
| **Scoreboard** | Held **Tab**, and automatically at match end |
| **Frag counter / frag message** | Your score, and **FRAGGED** with the name, above the crosshair, when you take one |
| **Ready bar** | Warmup — who is ready, and how many are still needed. **F4** readies you up |
| **Phase message** | Warmup, countdown, round start, round result, match end |
| **Round result** | End-of-round banner in the round-based modes |
| **Death screen** | On death — who fragged you and how, and the respawn countdown |
| **Match menu** | Escape, mid-match |

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
| **Loadout picker** | During the freeze — pick your primary and secondary for the next round. Amphi uses the same picker, and seats nobody until they have chosen |

There is no countdown number during the round freeze. The bomb beep is the
shared clock, and both teams hear it at the same time.

## Ammo Warning & Pickup Toast

- **Ammo warning** — fires when the equipped weapon drops below its low-ammo
  threshold, before the counter alone would register.
- **Pickup toast** — a brief confirmation of what you just picked up, paired
  with the pickup sound.

## Match Menu

Press **Escape** mid-match. The lobby's gold rail slides in over the match,
which keeps running behind it: nothing pauses in a multiplayer game, and the
rail says so. It opens with the lobby's logo, names the mode and the map, and
its keys are:

- **Resume** — back to the fight.
- **Join game**, or **Join Udon** and **Join Soba** in a team mode — while you
  are spectating. Each side's key says how many players it has; asking for the
  bigger side puts you on the smaller one.
- **Settings** — the settings screen below.
- **Spectate** — give up your spot and watch.
- **Leave match** — back to the lobby. When you started the match as a playtest from the map editor, this key reads **Return to Editor** instead and takes you back to your map.

The first key is inked, as the lobby inks the page you are on: Resume while you
play, Join while you watch. While the menu is up, **Tab** moves through its keys
instead of showing the scoreboard.

## Join Screen

A server reached with `connect` rather than through a lobby room shows the join
screen once the map has loaded: the match handoff's rail with every step done,
the mode and the map, and keys to join or to spectate first. **J** joins, and in
a team mode puts you on the side with fewer players.

## Spectating

Flying free, a card at the bottom left lists the keys: move to fly, jump and
crouch to rise and sink, sprint to go fast, fire to chase a player, **J** to
join. Health, armour, weapons and ammo are hidden while you fly free, since
they would describe nobody. Chasing a player, or watching a teammate after you
die in a round mode, puts their name above the bottom of the HUD between **←**
and **→**, which step to the previous and next living player — as do fire and
alt-fire while you watch a teammate.

Watching someone shows their screen: their weapon in front of you, switching
when they switch and flashing when they fire, swaying with their stride; their
health, armour, weapons, ammo and powerup timer on the HUD; their footsteps,
shots, pain and pickups heard as your own. When they die their weapon drops out
of view and the camera waits where they fell. In a mode with respawns it picks
them up when they come back; in a round mode it moves to the next living player
after a few seconds. The demo viewer shows a followed player the same way.

## Settings Overlay

Press **Escape** mid-match and pick **Settings** in the match menu: its four
pages take the rail's keys, and **Back** (or Escape) returns to the menu. The
lobby's Settings key opens the same screen, with its pages in the lobby's rail. Everything
is saved as you change it.

- **Controls** — a keyboard and a mouse coloured by what each key does, and the
  list of actions with their keys. Click a key to pick what it does, or click an
  action and press the key, click or wheel turn you want for it. A key does one
  thing, so giving it to an action takes it from the one that had it. Tab
  (scoreboard), T and Enter (chat), \` (console) and J (join) are read by the
  game directly and show as fixed. Mouse feel: sensitivity, sensitivity while
  aiming, and always run.
- **Gameplay** — the colour of your side and of enemies (anyone you can shoot,
  in free-for-all too), outline thickness and a brightness boost, over a
  preview on a real map; the crosshair with its own preview; field of view and
  connection info.
- **Video** — three presets for what costs frames (Smooth, Balanced, which is
  the game's defaults, and Pretty), then the settings themselves in four
  sections: Screen, Effects, World and Textures. Pips show each setting's
  frame-rate cost, and each section key how heavy it is set.
- **Audio** — music and effects: on or off, and their volume.

**Reset page** and **Reset all** ask once: the first press arms the key, and a
second within a few seconds does it.

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
