# Demo Cinematic Mode

An auto-edited highlight reel from a recorded match.

## Usage

```
demo 1                        # load a demo (from demolist, or by filename)
demoplay analyze              # print the highlights it finds, without playing
demoplay cinematic 2          # play a 2-minute reel
```

From the lobby's Demos page, **⚡ Highlights** does the same and lets you pick a reel of **1, 2 or 5 minutes**. Press **H** during playback to hide or show the overlay. See [Demos](../multiplayer/demos.md) for recording, listing and normal playback.

## How a reel is made

1. **Analyse.** `DemoAnalyzer` scans every frame of the demo for moments worth keeping and scores each one.
2. **Build.** `SequenceBuilder` picks the best moments to fit the length you asked for (about 8 seconds a segment on average), gives each a camera and a speed, and adds transitions. The top 15% of moments also get an **instant replay** from another angle.
3. **Play.** `CinematicDemoPlayer` drives the normal demo viewer through the segments, switching the camera for each one.

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

| Preset | Look | Speed |
|--------|------|-------|
| `chase_hero` | First-person chase on the killer | Normal |
| `orbit_kill` | Free camera orbiting the action | Slows to half speed just before the kill, then back |
| `rocket_jump_hero` | Below the jump arc, looking up | 0.75×, dropping to 0.25× at the peak |
| `victim_pov` | Chase on the victim before they die | Half speed just before the kill |
| `dramatic_zoom` | Wide-to-tight dolly | 0.25× around the kill |
| `replay_orbit` | Slow 360° orbit for the instant replay | 0.25× |

Transitions between segments are a cut, a crossfade, a white flash or a fade to black.

## Tips

- **Reel too short or empty?** Run `demoplay analyze` first. A demo of two idle players can have few highlights, and a longer reel cannot invent more.
- **Exporting.** There is no built-in video export; record the reel with a screen recorder.
