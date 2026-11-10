# Settings

Effects volume defaults to **100%**. Existing saved volume choices are retained;
use the Audio page's reset to restore the default, or set the Effects slider to 100%.

In **Gameplay / Who's who**, **Your team** and **Enemy team** each have a live
model preview, a **Model** dropdown and colour swatches underneath. Choose
**Police**, **Female Police**, **Cartel**, **RiotKitty** or **Robot**. Both sides
default to Police. Sound packs follow the model automatically: Police and
Cartel use male sounds, Female Police and RiotKitty use female sounds, and
Robot uses Bobot sounds.

The previews animate gently and show colour, outline and brightness changes as
you make them. They pause when hidden. A still image or model name is shown
while the live preview loads or if live rendering is unavailable.

The choice controls the bodies you see and player pain, death, jumping and your
own drowning voice. A player always sounds like the body they are drawn
with. In FFA the server gives every player, you included, a body of their own,
and every other player a colour, the same for everyone watching and in the
match's demo. Your own voice there is that body's, so these selections apply
in team modes, and in FFA only your own colour, outline and brightness follow
your settings. While
following a player or watching their demo POV, sides are relative to that
player. These are local presentation preferences; model choice keeps the same
player collision bounds. Bodies use a slightly enlarged visual fit for readability;
weapon hit rules stay the same. Blade swings animate the upper body while the legs
keep running, jumping or using the current movement animation.

The enemy model can also be **Random**, the default: each game you join draws
one of the other bodies, never the one your own side wears, and keeps it for
that game.

Your side starts **Pink** and enemies **White**, with brightening off, so
bodies keep their own colours inside a team-coloured outline.

Selections save automatically and apply to existing players. Gameplay reset
restores Police for your side, Random for enemies, Pink and White, and **Thin**
outlines (enabled, size 25). The console equivalents are `cl_team_ally_model`
and `cl_team_enemy_model`, accepting `police`, `female`, `cartel`, `riotkitty`
or `robot`, and `random` for enemies. Saved outline choices stay until changed
or reset.

Turning on **Video → Advanced → Color blindness** while both sides still have
their default colors switches them to Cyan for your side and Orange for enemies,
which stay apart for every kind of color blindness. A notice under the field
says so and offers **Undo**. Colors you picked yourself are left alone.

Press **Escape** in a match and pick **Settings**, or use the **Settings** key on the lobby's rail. The screen has five pages, and **preferences are saved as you change them**. If storage fails, a **Session only · could not save** notice explains that the changes work until the page is reloaded. Hovering a key or field with a hint shows it in the game's own tooltip. **Reset page** and **Reset all** ask once: press the key, then press it again within a few seconds to confirm.

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

## Controller

Press a controller button on the loading screen to start in controller mode.
Plugging one in, or moving a stick, does not select it. Starting with a click,
Enter, or a touch keeps those controls. To change later, use **Settings →
Controller → Use controller**, **Use keyboard / mouse**, or **Use touch** where
touch is available. Controller mode stays selected while you type or move the
mouse. A standard browser gamepad mapping is required; the page shows the
detected device and explains when its mapping is unsupported.

The existing menus work with **D-pad / left stick** to move the highlight,
**A** to select, and **B** to go back. **Menu** pauses or resumes. Left/right
adjusts a highlighted slider; **A** opens a dropdown, up/down changes its
option, and **A/B** accepts/cancels. The right stick scrolls the selected
control's scroll area. Text entry uses a physical or platform keyboard.

Choose **Standard** or **Bumper jump**, or select an action and press its new
button after releasing the controls. Select a button in the controller diagram
to choose its action instead. Conflicts ask before replacing a mapping. **×**
clears it. During press-to-bind, **B** can be assigned and **Menu** cancels.
Menu navigation stays fixed even when gameplay buttons change.

| Control | Standard | Bumper jump |
| --- | --- | --- |
| Left / right stick | Move / look | Same |
| RT / LT | Fire / aim | Same |
| A / B | Jump / crouch-slide | Previous weapon / crouch-slide |
| X / Y | Use / reload | Same |
| LB / RB | Previous / next weapon | Jump / next weapon |
| LS click / RS click | Sprint-walk modifier / blade | Same |
| D-pad left / right | Primary / secondary | Same |
| D-pad up / down | Ready / join | Same |
| View / Menu | Hold scoreboard / match menu | Same |

**Stick feel** has sliders for horizontal/vertical turn speed, response curve,
each stick's dead zone, and aiming sensitivity. Compact On/Off rows below the
sliders control inversion, swapped sticks, and aim assist. Movement uses full
speed outside its dead zone. With Always run on,
hold LS to walk. Controller turning is independent of mouse sensitivity.
The page shows live stick and trigger readings and highlights held buttons.
The same dead zones determine when controls count as released after a menu or
reconnection, so filtered stick drift does not prevent resuming. Back wins if
pressed together with Select. Open dropdown lists close when their settings
page closes or changes.
Use D-pad or left-stick Up/Down to browse the pause menu, A to select, and B to
go back. The main menu starts controller focus on its left rail. Entering a
room starts on map voting, or Ready if a map is already selected.

Controller mappings and personal look preferences follow your account. Dead
zones stay on the device; the selected input mode lasts for this page session.
**Reset page** on Controller leaves keyboard/mouse bindings alone, and resetting
Controls leaves controller mappings alone. Disconnecting releases input and
opens the match menu; reconnect, release the controls, and resume. The online
match continues while its menu is open.

## Controls

- **Keyboard and mouse.** A keyboard and a mouse drawn in colour by what each key does, with a list of every action beside them. Click a key to pick what it does, or click an action and then press the key, mouse button or wheel turn you want for it. A key does one thing, so giving it to an action takes it from the action that had it.
- **Fixed keys.** **Escape** (menu/cancel), **Tab** (scoreboard), **T** and **Enter** (global chat), **Y** (team chat), **`** (console) and **J** (join) are read by the game directly and show as fixed.
- **Mouse feel** (cvars `m_sensitivity`, `cl_ads_sensitivity`, `cl_autorun`):

  | Setting | Default | Notes |
  |---------|--------:|-------|
  | Sensitivity | 1.0 | 0.1 – 10 |
  | Sensitivity while aiming | 0.5 | `cl_ads_sensitivity`; a fraction of normal, 0.1 – 1 |
  | Always run | On | On: you run all the time, and holding **Sprint (Shift) walks**. Off: you walk, and Shift runs |

  In Chrome and Edge the game reads the mouse raw: the system's pointer
  acceleration (Windows' "Enhance pointer precision") does not apply while you
  play, and the same hand movement always turns the view the same amount.
  Firefox reads the mouse through the system's pointer settings.

## Gameplay

- **Team colours.** The colour of **your side** and of **enemies** (anyone you can shoot), each with its own outline colour. In free-for-all each opponent instead wears a colour of their own from the same palette, handed out by the server and kept for the match, so you can tell them apart and everyone sees the same colours; an opponent given your side's colour wears an unused one on your screen instead. A colour already used by the other side is refused. Cvars: `cl_team_ally_color`, `cl_team_enemy_color`, `cl_team_ffa_color` and their `_outline_color` pairs.
- **Outline** (`cl_player_outline`, `cl_player_outline_size`): Off, Thin (the default) or Bold, which is twice as thick.
- **Brighter players** (`cl_player_tint`, `cl_player_fullbright`, `cl_player_fullbright_intensity`): Off keeps original model colours with a coloured outline. Tint applies the chosen team colour; Some and Lots also brighten the body for visibility in dark corners. Off is the default.
- A preview on a real map shows all of the above as you change them.
- **Crosshair** with its own preview: on or off, **opens up when moving** (tightens again while you aim), size, opacity, colour, and the colour it flashes **when you hit** someone. The defaults are size 32 and green, flashing red on a hit. An empty weapon with no reserve shows a red X until ammunition is available. Cvars: `cg_crosshair`, `cg_crosshairSpread`, `cg_crosshairSize`, `cg_crosshairAlpha`, `cg_crosshairColor`, `cg_crosshairDmgColor`.
- **Field of view** (`cl_fov`): 80 – 110 degrees, default 90, horizontal at 16:9. It applies in play, in spectator freefly and when watching a player.
- **Gun size** (`cl_gunsize`): Normal (0, the default), Small (1, a tenth smaller) or Smallest (2, a fifth smaller). Your own first-person gun shrinks into its corner of the screen; aiming down sights brings it back to full size so the sights stay centred.
- **Explosion shake** (`cg_screenshake`): on by default, under View & info. The view shakes when a rocket, grenade, plasma or blade blast goes off near you; off, it stays still.
- **Shake when hit** (`cg_hitshake`): off by default. On, the view shakes when you take damage. Your own weapon's recoil kick is separate from both and stays.
- **FPS counter** (`show_fps`) and **Movement speed** (`cl_showspeed`): both on by default, under View & info. Saved choices take priority.
- **Match clock** (`cl_invertClock`): **Time left** (the default) counts down to the end; **Time played** counts up from 0:00 and runs on through overtime. Needs a server from v1.0.0-alpha or later; an older one keeps the countdown.
- **Switch to picked-up weapons** (`cl_autoswitch`): **On** (the default) takes out a weapon as you walk over it. **Off** keeps what you hold, so a fight with the spawn blade is not interrupted by a gun you run across; switch to it yourself when you want it. The only switch left is when a new gun replaces the one in your hands. Needs a server from v1.0.0-alpha or later.
- **Connection info** (`cl_netgraph`): Off, Numbers (ping, snapshot gaps, corrections and upload and download delay in the bottom-right corner) or Graph. See [HUD → NetGraph](./hud.md#netgraph-bottom-right-optional).

## Video

Four **presets** change only what costs frames, and leave brightness and outlines alone; **Ultralow** is the one exception and also turns outlines off. **Balanced** is what the game ships with.

| Preset | What it does |
|--------|--------------|
| **Ultralow** | Frames above all: half render resolution, no antialiasing, no dynamic lights, gibs, wall marks, teleport afterimages, fog or outlines, and map surfaces in flat colour. The other presets turn its frame-cost switches back on, but not the outlines: turn those back on yourself |
| **Smooth** | Many frames with the game's look intact: plain water, no light shafts, no bloom, no reflections, hard-edged halos |
| **Balanced** | The look the game ships with: bloom off, 4× texture sharpness |
| **Pretty** | Adds glow and reflections, and wants a strong graphics card |

Below the presets the settings are in five sections. Pips beside each setting show its frame-rate cost (light, medium or heavy), and each section's key says how heavy it is set overall.

| Section | Settings |
|---------|----------|
| **Screen** | Fullscreen, brightness (`r_exposure`), contrast (`r_contrast`), render resolution (`r_renderscale`, 25-100% of the window; the HUD stays sharp) and antialiasing (`r_msaa`, applies at the next start) |
| **Effects** | Bloom (`r_bloom`), reflections (`r_ssr`) and their strength (`r_ssr_strength`), light shafts (`r_godrays`: Off, Low or High), soft halos (`r_softhalos`: lamp halos and flares fade where they meet a wall instead of ending in a line), glow (`r_glow`), comic outlines on the world (`r_cel_outlines`), dynamic lights from shots, rockets, explosions and muzzle flashes (`r_dynamiclight`, applies next map), gibs (`r_gibs`), wall marks (`r_marks`) and the teleport afterimage (`r_teleport_ghost`) |
| **World** | Water quality (`r_water_quality`: Low, Medium or High), players reflected in water (`r_water_actors`, High water only), light cast from the map's glowing panels (`r_arealights`), fog (`r_fog`), how much the view warps under water (`r_underwater_distortion`) |
| **Textures** | Sharpness at an angle (`r_anisotropy`), detailed surfaces (`r_bsp_pbr`) |
| **Advanced** | Renderer (`r_renderer`): WebGPU (the default) or WebGL2. WebGPU draws faster, and the game uses WebGL2 on its own where the browser or graphics card has no WebGPU; applies at the next start. Map texture detail (`r_picmip`): Full, Soft, Softer, Blurred or Flat color; applies next map. **Color blindness** and **Correction strength**; see below |

Map texture detail is available with every preset. Balanced and Pretty start at
Full; Smooth starts at Soft (half-size base textures) and Ultralow at Flat
color. Flat color removes the
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

Two cards, **Music** and **Effects**, each with an on/off switch and a volume from 0 to 100% (`s_musicenabled` / `s_volume`, and `s_sfxenabled` / `s_sfxvolume`). Your music choice applies from startup: with music off, no map, lobby or menu starts a playlist, and turning it back on resumes the current one. To silence only the lobby's music, press the speaker key beside **Credits** on the Play page: it stays down while the lobby music is off, match music still plays, and your browser remembers the choice.

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
| `cl_gun` | 1 | Draws your own first-person gun; 0 hides it. Other players' guns are unaffected |
| `cg_weaponfov` | 60 | Field of view of your own first-person gun, 50 – 120 degrees; higher draws it smaller and further away |
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
available. The weapon model is controlled separately: `cl_gun 0` hides it.
