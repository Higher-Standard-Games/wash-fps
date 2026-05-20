# Demos

Server-side match recording in the `.shagdemo` binary format. Lobby-hosted demo listing. Client-side playback with a cinematic mode.

## Recording

The dedicated game server records every match by default. Recording is:

- **Server-side** — the client is never the recording authority.
- **Tick-aligned** — every player input and every entity state delta is captured per tick.
- **Binary format** — `.shagdemo` is the on-disk format. Compact; not human-readable. Decoded by `DemoReader`.

Recordings are stored on the dedicated server's filesystem (the path is server-configurable). The lobby server scans the directory and serves the file list to clients on request.

## Listing Demos

```
demolist                 # All recent demos from the lobby
demolist aerowalk        # Filter by map name
demolist <player_name>   # Filter by player participation
```

Output is a formatted table. The cached list is also used by `demo` and `demoplay` for shorthand-numeric demo selection.

## Loading a Demo

```
demo 1                                      # Load #1 from the last demolist
demo aerowalk_duel_20260319.shagdemo        # Load by filename
```

`demo` only loads — it doesn't start playback. Use `demoplay` for that.

## Playback

```
demoplay                          # Start normal playback from the beginning
demoplay cinematic <minutes>      # Generate + play a highlight reel
demoplay analyze                  # Print the highlight detection output
demoplay stop                     # Stop active playback
```

### Normal playback

The demo loads as a tick stream. The client replays each tick's snapshot through the same render path as live play — entity interpolation, weapon view, particle effects, all of it. The HUD shows tick number and total ticks.

You can scrub, pause, and speed-adjust via additional commands (TODO: document these).

### Cinematic mode

`demoplay cinematic 2` analyses the demo for highlight moments (kills, sprees, environmental kills, near-misses) and assembles a 2-minute auto-edited reel with camera tracking, dramatic angles, and slow motion on key events.

The analyser runs as `DemoService.analyzeLoadedDemo()` and outputs a list of timestamped highlights with scores. `demoplay analyze` prints this list without starting playback — useful for debugging the heuristics.

### Stop / cleanup

`demoplay stop` cleanly halts playback, releases the `DemoViewer`, and returns the camera + HUD to spectator-like state. The currently-loaded demo stays loaded — you can `demoplay` again to restart, or `demo <other>` to load a different one.

## File Format Reference

`.shagdemo` is decoded by `src/games/fps/client/DemoService.ts`'s underlying `DemoReader`. Key fields per tick:

- All player inputs (movement, aim, fire flags)
- All entity state deltas (position, velocity, health, animation state)
- Server events (kills, pickups, match-state transitions)

For full schema, read `src/games/fps/client/DemoReader.ts` (TODO: extract this into a public doc page).

## TODO

- Demo scrubbing commands (jump-to-tick, speed control)
- Demo upload + remote sharing flow (currently lobby-local)
- Cinematic heuristic tuning
- Recording opt-out / privacy

For now, the demo system's user-facing surface is `demo` / `demolist` / `demoplay` plus the lobby's Demos tab.
