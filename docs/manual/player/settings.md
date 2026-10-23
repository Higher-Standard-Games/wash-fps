# Settings

Effects volume defaults to **100%**. Existing saved volume choices are retained;
use the Audio page's reset to restore the default, or set the Effects slider to 100%.

In **Gameplay → Who's who**, each side has a **Sounds** dropdown beside its
colors: Male, Female or Bobot. Your side defaults to Male and enemies to Bobot.
The selection affects player pain, death and jumping; your own drowning voice
also uses your side's bank. In FFA, everyone else uses the enemy bank. While
following a player or watching their demo POV, sides are relative to that player.
Selections save automatically and Gameplay reset restores the defaults.

Turning on **Video → Advanced → Color blindness** while both sides still have
their default colors switches them to Cyan for your side and Orange for enemies,
which stay apart for every kind of color blindness. A notice under the field
says so and offers **Undo**. Colors you picked yourself are left alone.

Press **Escape** in a match and pick **Settings**, or use the **Settings** key on the lobby's rail. The screen has four pages, and **preferences are saved as you change them**. If storage fails, a **Session only · could not save** notice explains that the changes work until the page is reloaded. Hovering a key or field with a hint shows it in the game's own tooltip. **Reset page** and **Reset all** ask once: press the key, then press it again within a few seconds to confirm.

Over a match the **Video** page is locked with the notice **Video settings change in the lobby**; leave the match to change it. Fullscreen still works with **Alt+Enter**.

Drop-down fields open their list under the field, mark the current choice, and work with the mouse or with the arrow keys, **Home**, **End**, **Enter** and **Escape**.

Most settings are console variables (cvars), for example `cl_fov 100`. Key bindings use their own storage. Fullscreen is a browser/window action and is not a saved cvar preference. Reset restores settings and bindings, not browser fullscreen state.

Use **Alt+Enter** or the Fullscreen setting for fullscreen play. In browsers
with Keyboard Lock support, allow keyboard capture when asked: while the mouse
is captured for gameplay, movement shortcuts such as Ctrl+W then reach the game
instead of closing the tab. Remapped movement keys are included. Escape stays
available, and protection releases when you open menus/chat, leave fullscreen
or switch away. Browser F11 fullscreen alone does not enable this feature.
Without support or permission, browser shortcuts can still close the tab.

### Settings follow your account

While you are logged in to the lobby, your key bindings, game preferences (the
`cl_`, `cg_`, `s_` and `m_` cvars, such as field of view and sensitivity), color
blindness correction, HUD layout, UI theme and remembered loadouts are saved to
your account and arrive in any browser that logs in with your key. Changes upload
a moment after you make them. Graphics stay with the device, as do connection
settings such as `cl_netgraph` and `cl_interp`. An account with no saved settings
takes the first browser's; the first time an account's settings replace a
browser's own, that browser keeps a copy of its previous settings.

Sliders apply immediately. Their saved values are combined until you release the
slider, leave the page, or pause for 200 ms.

## Controls

- **Keyboard and mouse.** A keyboard and a mouse drawn in colour by what each key does, with a list of every action beside them. Click a key to pick what it does, or click an action and then press the key, mouse button or wheel turn you want for it. A key does one thing, so giving it to an action takes it from the action that had it.
- **Fixed keys.** **Escape** (menu/cancel), **Tab** (scoreboard), **T** and **Enter** (global chat), **Y** (team chat), **`** (console) and **J** (join) are read by the game directly and show as fixed.
- **Mouse feel** (cvars `m_sensitivity`, `cl_ads_sensitivity`, `cl_autorun`):

  | Setting | Default | Notes |
  |---------|--------:|-------|
  | Sensitivity | 1.0 | 0.1 – 10 |
  | Sensitivity while aiming | 0.5 | `cl_ads_sensitivity`; a fraction of normal, 0.1 – 1 |
  | Always run | On | On: you run all the time, and holding **Sprint (Shift) walks**. Off: you walk, and Shift runs |

## Gameplay

- **Team colours.** The colour of **your side** and of **enemies** (anyone you can shoot), each with its own outline colour. In free-for-all each opponent instead wears a colour of their own from the same palette, kept for the match, so you can tell them apart; your side's colour is left out of it. A colour already used by the other side is refused. Cvars: `cl_team_ally_color`, `cl_team_enemy_color`, `cl_team_ffa_color` and their `_outline_color` pairs.
- **Outline** (`cl_player_outline`, `cl_player_outline_size`): Off, Thin (the default) or Bold, which is twice as thick.
- **Brighter players** (`cl_player_fullbright`, `cl_player_fullbright_intensity`): Off, Some or Lots. It makes players stand out in dark corners.
- A preview on a real map shows all of the above as you change them.
- **Crosshair** with its own preview: on or off, **opens up when moving** (tightens again while you aim), size, opacity, colour, and the colour it flashes **when you hit** someone. The defaults are size 32 and green, flashing red on a hit. An empty weapon with no reserve shows a red X until ammunition is available. Cvars: `cg_crosshair`, `cg_crosshairSpread`, `cg_crosshairSize`, `cg_crosshairAlpha`, `cg_crosshairColor`, `cg_crosshairDmgColor`.
- **Field of view** (`cl_fov`): 80 – 110 degrees, default 90, horizontal at 16:9.
- **FPS counter** (`show_fps`) and **Movement speed** (`cl_showspeed`): both on by default, under View & info. Saved choices take priority.
- **Match clock** (`cl_invertClock`): **Time left** (the default) counts down to the end; **Time played** counts up from 0:00 and runs on through overtime. Needs a server from v1.0.0-alpha or later; an older one keeps the countdown.
- **Switch to picked-up weapons** (`cl_autoswitch`): **On** (the default) takes out a weapon as you walk over it. **Off** keeps what you hold, so a fight with the spawn blade is not interrupted by a gun you run across; switch to it yourself when you want it. The only switch left is when a new gun replaces the one in your hands. Needs a server from v1.0.0-alpha or later.
- **Connection info** (`cl_netgraph`): Off, Numbers (ping, snapshot gaps, corrections and upload and download delay in the bottom-right corner) or Graph. See [HUD → NetGraph](./hud.md#netgraph-bottom-right-optional).

## Video

Three **presets** change only what costs frames, and leave brightness and outlines alone. **Balanced** is what the game ships with.

| Preset | What it does |
|--------|--------------|
| **Smooth** | The most frames: plain water, no light shafts, no bloom, no reflections |
| **Balanced** | The look the game ships with |
| **Pretty** | Adds glow and reflections, and wants a strong graphics card |

Below the presets the settings are in five sections. Pips beside each setting show its frame-rate cost (light, medium or heavy), and each section's key says how heavy it is set overall.

| Section | Settings |
|---------|----------|
| **Screen** | Fullscreen, brightness (`r_exposure`) and contrast (`r_contrast`) |
| **Effects** | Bloom (`r_bloom`), reflections (`r_ssr`) and their strength (`r_ssr_strength`), light shafts (`r_godrays`: Off, Low or High), glow (`r_glow`), comic outlines on the world (`r_cel_outlines`) |
| **World** | Water quality (`r_water_quality`: Low, Medium or High), players reflected in water (`r_water_actors`, High water only), light cast from the map's glowing panels (`r_arealights`), how much the view warps under water (`r_underwater_distortion`) |
| **Textures** | Sharpness at an angle (`r_anisotropy`), detailed surfaces (`r_bsp_pbr`) |
| **Advanced** | Map texture detail (`r_picmip`): Full, Soft, Softer, Blurred or Flat color; applies next map. **Color blindness** and **Correction strength**; see below |

Map texture detail is available with every preset. Balanced and Pretty start at
Full; Smooth starts at Soft (half-size base textures). Flat color removes the
pattern from static opaque map surfaces while preserving lighting. Transparent
effects, sky and shaders marked to preserve detail stay at full resolution.

### Color blindness

**Color blindness** corrects the picture so colors that look alike to you move
apart. Each choice explains itself in the list; if you are not sure which fits,
try each and keep the one where colors are easiest to tell apart. **Correction
strength** sets how far the colors shift. Presets do not change either setting,
and both follow your account.

| Choice | `r_colorcorrection` |
|--------|--------------------:|
| Off (default) | 0 |
| Red-weak (protanopia) | 1 |
| Green-weak (deuteranopia) | 2 |
| Blue-yellow (tritanopia) | 3 |

`r_colorcorrection_strength` runs from 0 to 1 (default 1). Both apply at once,
also from the console in a match. Off, the correction costs nothing; on, it is
one light full-screen pass.

For map makers, `r_colorsimulation` 1, 2 or 3 shows the screen as a red-weak,
green-weak or blue-yellow eye sees it. It is console-only and is not saved.

## Audio

Two cards, **Music** and **Effects**, each with an on/off switch and a volume from 0 to 100% (`s_musicenabled` / `s_volume`, and `s_sfxenabled` / `s_sfxvolume`). Your music choice applies from startup: with music off, no map, lobby or menu starts a playlist, and turning it back on resumes the current one.

The **Mix** card separately adjusts Effects, Players, Hit sound and Announcer (`cg_volume_effects`, `cg_volume_players`, `cg_volume_hitsound`, `cg_volume_announcer`) as shares of the Effects volume.

Hit confirmation uses four sounds for increasing damage: `hit_3` below 25,
`hit_2` from 25, `hit_1` from 50 and `hit_0` from 75 damage.

## Console-only variables

A few settings have no screen yet:

| Cvar | Default | Effect |
|------|--------:|--------|
| `cg_bob` | 1 | View bobbing while walking (0 or 1) |
| `cg_bobamplitude` | 1.0 | Vertical bob strength, 0 – 5 |
| `cg_bobfrequency` | 0.03 | Bob speed, 0.01 – 0.06; higher is faster footsteps |
| `cg_bobroll` | 0.35 | Roll tilt during the bob, in degrees, 0 – 2 |
| `cg_boblean` | 1.0 | Forward lean while running fast, in degrees, 0 – 5 |
| `cl_interp` | 0 | Snapshot interpolation delay in ms; 0 picks it automatically |
| `cl_remotehitbox` | 0 | Draws other players' hitboxes (a debugging aid) |

## See also

- [Controls](./index.md#controls-default) — the default key bindings
- [HUD](./hud.md) — the on-screen elements these settings change


## Clean screenshots

Enter `cl_hud 0` in the console to hide the game HUD, crosshair, spectator
instructions, demo controls, FPS counter and debug overlays. Close the console
before taking the shot. Enter `cl_hud 1` to restore them. This is a session-only
setting and defaults to visible after reloading. Menus and the console remain
available. The weapon model is controlled separately.
