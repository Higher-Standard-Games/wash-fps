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
2. **Build.** `SequenceBuilder` picks the best moments to fit the length you asked for (about 11 seconds a highlight; a frag sequence counts its own length), and films each one as a **scene** of shots (see below).
3. **Play.** `CinematicDemoPlayer` drives the normal demo viewer through the shots, rewinding and switching the camera for each one.

### A scene

Every highlight is cut the same way, so the reel reads like one edited video:

1. **Intro**: a third-person fly-by from 2 seconds before the frag (a rocket jump from its take-off), easing down to 0.35× for the last 0.6 seconds.
2. **Eyes**: a quick white flash rewinds to the same moment, seen through the killer's eyes, with a beat of half speed on the frag. A multi-kill plays its whole run here, with a counter stamped on each frag. When the victim saw it coming (and the scene before was not already theirs), the eyes are the victim's instead: their shot slows as the frag lands and ends on it.
3. **Ending**: a crossfade into a slow 0.4× orbit round the frag. After the victim's eyes it cuts straight in at the frag, so the view goes from their eyes to the outside of the hit, never into the killer's eyes. The orbit keeps looking at where the victim died once they have left the recording.

Slow motion eases in and out over about 0.2 seconds of game time (0.4 into the intro's slow-down) rather than switching speed in a step.

### Frag sequences

A **frag sequence** is one player's frags in a row (see [What counts as a highlight](#what-counts-as-a-highlight)). It is filmed as it happened rather than as three replays:

1. A camera **chases the killer** in third person into the first frag.
2. Each frag is seen **through the killer's eyes** from 1.2 seconds before it to 0.5 after, with a beat of half speed and the **frag counter** (1, 2, 3...) stamped on the picture. Frags close together share one eyes shot.
3. Between frags the chase picks up again at 1.35× speed, easing back to full speed by the next frag. A wait of more than three seconds is cut short: the reel **jumps ahead through speed lines** to the last 2.5 seconds of the chase.
4. The scene ends on the usual slow orbit round the last frag.

### Transitions

Each transition means one thing, so a viewer learns to read them:

| Transition | Means |
|------------|-------|
| White flash | Rewind: the same moment again, from a player's eyes |
| Speed lines | Jumping ahead in time: across a long wait in a frag sequence, and into some scenes |
| Crossfade | The same moment from another angle (the ending orbit) |
| Fade to black | The scene is over |

Each scene ends with a fade to black, a white flash or a crossfade into the next one, picked from the highlight itself, so the same demo always cuts the same way. About one cut in three between scenes, never two running, comes in on **speed lines** instead: the reel's best frag scenes first, then movement clips. The reel always fades in from black and out to black over a full second, so a recording of it starts and ends clean.

### Freeze frames

The reel's best frag scene, and any play of three or more frags, ends on a **freeze frame**, in one scene of three at most and never more than three a reel: just after the frag, the ending orbit stops for 1.4 seconds as a comic panel, with a paper border, halftone corners and a caption burst (**DOUBLE!**, **TRIPLE!**, **QUAD!**, *n* **FRAGS!**; for a single frag **ROCKET JUMP!**, **AIRSHOT!**, **SNIPED!**, **CLUTCH!**, **REVENGE!** or **FRAG!**).

The speed lines, freeze frames and frag counters are drawn by the same code in the demo viewer and in an exported video, so a video shows what the viewer shows.

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
| `multi_kill` | Several kills by one player, all within 3 seconds |
| `frag_sequence` | Several kills by one player taking longer than 3 seconds: two within 5 seconds of each other, or three within 10 seconds, and on for as long as the run keeps up. The killer dying ends it. |
| `airborne_frag` | A kill made with the killer's feet at least 32 units above the ground (a hop off a step does not count) |
| `streak_kill` | A kill that extends a streak |
| `first_blood` | The match's first kill |
| `movement` | A trick jump: wall jumps, slides or a chain of hops, faster than sprinting |

Each moment carries 3 seconds of lead-in and 2 seconds of follow-through; a multi-kill or frag sequence runs from before its first frag to after its last.

### Scoring

A kill starts at 10 points. Tags then multiply the score:

| Tag | × | Tag | × |
|-----|--:|-----|--:|
| `rocket_jump` (rising over 450 u/s) | 1.8 | `unstoppable` | 1.6 |
| `airborne` | 1.5 | `raging` | 1.4 |
| `first_blood` | 1.5 | `low_hp` (under 30 HP) | 1.3 |
| `on_fire` | 1.2 | `long_range` (over 1500 u) | 1.2 |
| `high_speed` (over 600 u/s) | 1.2 | `close_range` (under 150 u), `revenge` | 1.1 |

A rocket jump replaces the airborne bonus rather than stacking with it, and a multi-kill or frag sequence adds 50% per extra kill. Where two frags overlap in time, only the higher-scoring one is kept.

## Cameras and speed

| Preset | Shot | Look |
|--------|------|------|
| `rocket_jump_hero` | Intro, for a rocket jump (rising faster than a plain or wall jump can) | Ahead of and below the jump along its heading, then beside it, then behind the apex |
| `dramatic_zoom` | Intro, for a long-range frag | Wide-to-tight dolly onto the victim |
| `orbit_kill` | Intro, otherwise | Starts over the killer's shoulder and swings round the action, about 90° a second |
| `chase_hero` | Eyes | The killer's view |
| `victim_pov` | Eyes, when the victim of a single frag faced the killer (never twice running) | The victim's view, up to the frag |
| `trick_follow` | Movement clip; a frag sequence's chase | Rides behind and beside the player along their recorded route, from behind where they look while they stand about |
| `replay_orbit` | Ending | Orbits both players when they're close, the victim when the shot crossed the map |

A zoom's field of view stays with its own shot; the next shot, and the free camera after the reel, get theirs back.

## Tips

- **Reel too short or empty?** Run `demoplay analyze` first. A demo of two idle players can have few highlights, and a longer reel cannot invent more.
- **Exporting.** **Export video** (or `videoexport`) renders the reel to an MP4; see [Video export](../multiplayer/demos.md#video-export). With a song chosen, the cuts between scenes land on its beats. To capture the viewer with a screen recorder instead, press **H** first for the clean view: the recording then starts and ends on black, with the title and end cards and no pointer.
