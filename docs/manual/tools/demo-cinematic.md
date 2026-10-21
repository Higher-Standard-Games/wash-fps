# Demo Cinematic Mode

An auto-edited highlight reel from a recorded match.

## Usage

```
demo 1                        # load a demo (from demolist, or by filename)
demoplay analyze              # print the highlights it finds, without playing
demoplay cinematic 2          # play a 2-minute reel
```

From the lobby's Demos page, **⚡ Highlights** does the same and lets you pick a reel
of **1, 2 or 5 minutes**. The shared playback bar offers pause, a timeline and
previous/next shot controls; the card and counter number the highlights. **HUD** toggles the game HUD during first-person shots;
**H** shows or hides playback overlays and replay chat.
**Escape** or the gold exit plate leaves playback. See [Demos](../multiplayer/demos.md).

## How a reel is made

1. **Analyse.** `DemoAnalyzer` scans every frame of the demo for moments worth keeping and scores each one.
2. **Build.** `SequenceBuilder` picks the best moments to fit the length you asked for (about 11 seconds a highlight), and films each one as a **scene** of three shots of the same moment (see below).
3. **Play.** `CinematicDemoPlayer` drives the normal demo viewer through the shots, rewinding and switching the camera for each one.

### A scene

Every highlight is cut the same way, so the reel reads like one edited video:

1. **Intro**: a third-person fly-by from 2 seconds before the frag (a rocket jump from its take-off), slowing to 0.35× for the last 0.6 seconds.
2. **Eyes**: a quick white flash rewinds to the same moment, seen through the killer's eyes (or the victim's, when they saw it coming), with a beat of half speed on the frag. A multi-kill plays its whole run here.
3. **Ending**: a crossfade into a slow 0.4× orbit round the frag.

Each scene then ends with a fade to black, a white flash or a crossfade into the next one. The effect is picked from the highlight itself, so the same demo always cuts the same way. The reel always opens and closes on black.

The analyser works on the recorded frames alone and touches no rendering or network code. It lives in the engine repo (`src/shared/demo/`); the player is `client/CinematicDemoPlayer.ts`.

## What counts as a highlight

| Type | What it is |
|------|------------|
| `frag` | A kill |
| `multi_kill` | Several kills within 200 ticks (1.6 s) |
| `airborne_frag` | A kill made while the killer was in the air |
| `streak_kill` | A kill that extends a streak |
| `first_blood` | The match's first kill |
| `movement` | A trick jump, a high-speed run or a big height gain, with no kill |

Each moment carries 3 seconds of lead-in and 2 seconds of follow-through.

### Scoring

A kill starts at 10 points and a movement moment at 5. Tags then multiply the score:

| Tag | × | Tag | × |
|-----|--:|-----|--:|
| `rocket_jump` | 1.8 | `unstoppable` | 1.6 |
| `airborne` | 1.5 | `raging` | 1.4 |
| `first_blood` | 1.5 | `low_hp` (under 30 HP) | 1.3 |
| `trick_jump` | 1.3 | `long_range` (over 1500 u) | 1.2 |
| `on_fire` | 1.2 | `high_speed` (over 600 u/s) | 1.2 |
| `height_gain` | 1.2 | `close_range` (under 150 u), `revenge` | 1.1 |

A rocket jump replaces the airborne bonus rather than stacking with it, and a multi-kill adds 50% per extra kill. Where two moments overlap in time, only the higher-scoring one is kept.

## Cameras and speed

| Preset | Shot | Look |
|--------|------|------|
| `rocket_jump_hero` | Intro, for a rocket jump | Ahead of and below the jump along its heading, then beside it, then behind the apex |
| `dramatic_zoom` | Intro, for a long-range frag | Wide-to-tight dolly onto the victim |
| `orbit_kill` | Intro, otherwise | Starts over the killer's shoulder and swings round the action, about 90° a second |
| `chase_hero` | Eyes | The killer's view |
| `victim_pov` | Eyes, when the victim faced the killer (never twice running) | The victim's view, then the killer's once they die |
| `replay_orbit` | Ending | Orbits both players when they're close, the victim when the shot crossed the map |

A zoom's field of view stays with its own shot; the next shot, and the free camera after the reel, get theirs back.

## Tips

- **Reel too short or empty?** Run `demoplay analyze` first. A demo of two idle players can have few highlights, and a longer reel cannot invent more.
- **Exporting.** There is no built-in video export; record the reel with a screen recorder.
