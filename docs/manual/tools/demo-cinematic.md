# Demo Cinematic Mode

Auto-edited highlight reel from a recorded match.

## Usage

```
demo aerowalk_duel_20260319.shagdemo
demoplay cinematic 2          # 2-minute reel
```

The analyzer scores every tick for "highlight worthiness" (kills, sprees, environmental kills, near-misses, etc.), picks the best moments to fit your requested duration, generates camera paths (orbit, dolly-in, slow-mo), and plays the reel back through the same `DemoViewer` engine as normal playback.

## TODO

This page is a stub. Full coverage to come:

- Highlight scoring heuristics (what counts, why)
- Camera path generators (orbit, lead-in, slow-mo)
- Tuning the analyzer via cvars / parameters
- Exporting a cinematic reel (or recording it through OBS)
- Comparison with normal playback (frame interpolation, time-warping)

For now, see `src/games/fps/client/DemoService.ts` `analyzeLoadedDemo()` and `loadAndPlayCinematic()` for the implementation.
