# Demo Cinematic Mode

An auto-edited highlight reel from a recorded match.

## Usage

```
demo 1                        # load a demo (from demolist, or by filename)
demoplay analyze              # print the highlights it finds, without playing
demoplay cinematic 2          # play a 2-minute reel
```

From the lobby's Demos page, **⚡ Highlights** does the same and lets you pick a reel
of **1, 2 or 3 minutes**. The shared playback bar offers pause, a timeline and
previous/next shot controls; the card and counter number the highlights. **HUD** toggles the game HUD during first-person shots;
**Space** pauses, **←** / **→** go to the previous or next shot, and **H** switches the clean view
(no overlays, chat or pointer) for recording.
**Escape** or the gold exit plate leaves playback. When a reel ends, **Replay** plays it again and **Exit** goes back to the demos. See [Demos](../multiplayer/demos.md#keys) for every key.

## Title and end cards

A reel fades in on a **title card** held for a few seconds over black: who
played against whom, cut like the scoreboard.

- **Teams:** each team's plate over all its players, Udon against Soba.
- **Duel:** the two players' names on gold plates, one against the other.
- **Free for all:** everyone, up to eight names and a count of the rest.

When the reel has faded out, an **end card** sits above the Replay and Exit keys:
the match's **top fragger** with their frags, the reel's **best moment** and who
made it, and how many highlights and trick jumps the reel held. Both cards stay
up in the clean view, so they are part of a recording; Replay shows the title
card again.

## How a reel is made

1. **Analyse.** `DemoAnalyzer` scans every frame of the demo for moments worth keeping and scores each one.
2. **Build.** `SequenceBuilder` picks the best moments to fit the length you asked for (about 11 seconds a highlight), and films each one as a **scene** of three shots of the same moment (see below).
3. **Play.** `CinematicDemoPlayer` drives the normal demo viewer through the shots, rewinding and switching the camera for each one.

### A scene

Every highlight is cut the same way, so the reel reads like one edited video:

1. **Intro**: a third-person fly-by from 2 seconds before the frag (a rocket jump from its take-off), slowing to 0.35× for the last 0.6 seconds.
2. **Eyes**: a quick white flash rewinds to the same moment, seen through the killer's eyes (or the victim's, when they saw it coming), with a beat of half speed on the frag. A multi-kill plays its whole run here.
3. **Ending**: a crossfade into a slow 0.4× orbit round the frag.

Each scene then ends with a fade to black, a white flash or a crossfade into the next one. The effect is picked from the highlight itself, so the same demo always cuts the same way. The reel always fades in from black and out to black over a full second, so a recording of it starts and ends clean.

### Movement clips

Between frag scenes the reel cuts in the best **trick jumps**: about one for every two frag scenes, at most two in a row, and never as the opening or closing shot. A clip follows the run from behind with a beat of slow motion on its best moment (the top of a wall-jump climb, else the first wall jump, else the fastest point), then flashes back into the player's eyes for that moment. A demo with no frags at all makes a reel of trick jumps alone.

A run counts while the player goes faster than sprinting (450 u/s) in the air or on a slide, touching the ground for no more than about a third of a second between hops, for at least 1.2 seconds. It is kept when it has a wall jump, three or more hops, a slide into a jump, or tops 700 u/s:

| Tag | When | × |
|-----|------|--:|
| `wall_jump` | One or more wall jumps | 1.3 |
| `bunny_hop` | Three or more hops | 1.2 |
| `slide` | A slide in the run | 1.1 |
| `height_gain` | Wall jumps that climb 96 u or more | 1.2 |
| `trick_jump` | Two of wall jumps, hops and slides in one run | 1.3 |
| `high_speed` | Over 700 u/s | 1.2 |

Trick jumps are scored among themselves (from 5 points), so they never compete with frags for a place.

The analyser works on the recorded frames alone and touches no rendering or network code. It lives in the engine repo (`src/shared/demo/`); the player is `client/CinematicDemoPlayer.ts`.

## What counts as a highlight

| Type | What it is |
|------|------------|
| `frag` | A kill |
| `multi_kill` | Several kills within 200 ticks (1.6 s) |
| `airborne_frag` | A kill made with the killer's feet at least 32 units above the ground (a hop off a step does not count) |
| `streak_kill` | A kill that extends a streak |
| `first_blood` | The match's first kill |
| `movement` | A trick jump: wall jumps, slides or a chain of hops, faster than sprinting |

Each moment carries 3 seconds of lead-in and 2 seconds of follow-through.

### Scoring

A kill starts at 10 points. Tags then multiply the score:

| Tag | × | Tag | × |
|-----|--:|-----|--:|
| `rocket_jump` (rising over 450 u/s) | 1.8 | `unstoppable` | 1.6 |
| `airborne` | 1.5 | `raging` | 1.4 |
| `first_blood` | 1.5 | `low_hp` (under 30 HP) | 1.3 |
| `on_fire` | 1.2 | `long_range` (over 1500 u) | 1.2 |
| `high_speed` (over 600 u/s) | 1.2 | `close_range` (under 150 u), `revenge` | 1.1 |

A rocket jump replaces the airborne bonus rather than stacking with it, and a multi-kill adds 50% per extra kill. Where two frags overlap in time, only the higher-scoring one is kept.

## Cameras and speed

| Preset | Shot | Look |
|--------|------|------|
| `rocket_jump_hero` | Intro, for a rocket jump (rising faster than a plain or wall jump can) | Ahead of and below the jump along its heading, then beside it, then behind the apex |
| `dramatic_zoom` | Intro, for a long-range frag | Wide-to-tight dolly onto the victim |
| `orbit_kill` | Intro, otherwise | Starts over the killer's shoulder and swings round the action, about 90° a second |
| `chase_hero` | Eyes | The killer's view |
| `victim_pov` | Eyes, when the victim faced the killer (never twice running) | The victim's view, then the killer's once they die |
| `trick_follow` | Movement clip | Rides behind and beside the player along their recorded route |
| `replay_orbit` | Ending | Orbits both players when they're close, the victim when the shot crossed the map |

A zoom's field of view stays with its own shot; the next shot, and the free camera after the reel, get theirs back.

## Tips

- **Reel too short or empty?** Run `demoplay analyze` first. A demo of two idle players can have few highlights, and a longer reel cannot invent more.
- **Exporting.** There is no built-in video export; record the reel with a screen recorder. Press **H** first for the clean view: the recording then starts and ends on black, with the title and end cards and no pointer.
