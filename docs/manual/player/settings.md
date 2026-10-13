# Settings

Press **Escape** in a match and pick **Settings**, or use the **Settings** key on the lobby's rail. The screen has four pages, and **preferences are saved as you change them**. If storage fails, a **Session only · could not save** notice explains that the changes work until the page is reloaded. **Reset page** and **Reset all** ask once: press the key, then press it again within a few seconds to confirm.

Most settings are console variables (cvars), for example `cl_fov 100`. Key bindings use their own storage. Fullscreen is a browser/window action and is not a saved cvar preference. Reset restores settings and bindings, not browser fullscreen state.

Sliders apply immediately. Their saved values are combined until you release the
slider, leave the page, or pause for 200 ms.

## Controls

- **Keyboard and mouse.** A keyboard and a mouse drawn in colour by what each key does, with a list of every action beside them. Click a key to pick what it does, or click an action and then press the key, mouse button or wheel turn you want for it. A key does one thing, so giving it to an action takes it from the action that had it.
- **Fixed keys.** **Escape** (menu/cancel), **Tab** (scoreboard), **T** and **Enter** (chat), **`** (console) and **J** (join) are read by the game directly and show as fixed.
- **Mouse feel** (cvars `m_sensitivity`, `cl_ads_sensitivity`, `cl_autorun`):

  | Setting | Default | Notes |
  |---------|--------:|-------|
  | Sensitivity | 1.0 | 0.1 – 10 |
  | Sensitivity while aiming | 0.5 | `cl_ads_sensitivity`; a fraction of normal, 0.1 – 1 |
  | Always run | On | On: you run all the time, and holding **Sprint (Shift) walks**. Off: you walk, and Shift runs |

## Gameplay

- **Team colours.** The colour of **your side** and of **enemies** (anyone you can shoot, so in free-for-all that is everyone else), each with its own outline colour. A colour already used by the other side is refused. Cvars: `cl_team_ally_color`, `cl_team_enemy_color`, `cl_team_ffa_color` and their `_outline_color` pairs.
- **Outline** (`cl_player_outline`, `cl_player_outline_size`): Off, Thin (the default) or Bold, which is twice as thick.
- **Brighter players** (`cl_player_fullbright`, `cl_player_fullbright_intensity`): Off, Some or Lots. It makes players stand out in dark corners.
- A preview on a real map shows all of the above as you change them.
- **Crosshair** with its own preview: on or off, **opens up when moving** (tightens again while you aim), size, opacity, colour, and the colour it flashes **when you hit** someone. The defaults are green, flashing red on a hit. Cvars: `cg_crosshair`, `cg_crosshairSpread`, `cg_crosshairSize`, `cg_crosshairAlpha`, `cg_crosshairColor`, `cg_crosshairDmgColor`.
- **Field of view** (`cl_fov`): 80 – 110 degrees, default 90, horizontal at 16:9.
- **FPS counter** (`show_fps`) and **Movement speed** (`cl_showspeed`): both on by default, under View & info. Saved choices take priority.
- **Connection info** (`cl_netgraph`): Off, Numbers (ping and estimated snapshot gaps in the bottom-right corner) or Graph. See [HUD → NetGraph](./hud.md#netgraph-bottom-right-optional).

## Video

Three **presets** change only what costs frames, and leave brightness and outlines alone. **Balanced** is what the game ships with.

| Preset | What it does |
|--------|--------------|
| **Smooth** | The most frames: plain water, no light shafts, no bloom, no reflections |
| **Balanced** | The look the game ships with |
| **Pretty** | Adds glow and reflections, and wants a strong graphics card |

Below the presets the settings are in four sections. Pips beside each setting show its frame-rate cost (light, medium or heavy), and each section's key says how heavy it is set overall.

| Section | Settings |
|---------|----------|
| **Screen** | Fullscreen, brightness (`r_exposure`) and contrast (`r_contrast`) |
| **Effects** | Bloom (`r_bloom`), reflections (`r_ssr`) and their strength (`r_ssr_strength`), light shafts (`r_godrays`: Off, Low or High), glow (`r_glow`), comic outlines on the world (`r_cel_outlines`) |
| **World** | Water quality (`r_water_quality`: Low, Medium or High), players reflected in water (`r_water_actors`, High water only), light cast from the map's glowing panels (`r_arealights`), how much the view warps under water (`r_underwater_distortion`) |
| **Textures** | Sharpness at an angle (`r_anisotropy`), detailed surfaces (`r_bsp_pbr`) |

## Audio

Two cards, **Music** and **Effects**, each with an on/off switch and a volume from 0 to 100% (`s_musicenabled` / `s_volume`, and `s_sfxenabled` / `s_sfxvolume`).

The **Mix** card separately adjusts Effects, Players, Hit sound and Announcer (`cg_volume_effects`, `cg_volume_players`, `cg_volume_hitsound`, `cg_volume_announcer`) as shares of the Effects volume.

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
