# Benchmarks

Repeatable measurements of the server and HUD code, so a change can be judged by numbers. Design, rules and the plan for what comes next: [`docs/research/performance-and-demos.md`](../docs/research/performance-and-demos.md). What the first numbers decided: [`docs/research/v0.9.25-QA.md`](../docs/research/v0.9.25-QA.md).

## Running

This game is a submodule and imports the engine by relative path, so the benchmarks run from the **engine's** root with this repo copied (not symlinked) into `src/games/fps/`.

```bash
npx vite-node src/games/fps/bench/run.ts                       # every scenario, 3 runs each
npx vite-node src/games/fps/bench/run.ts -- --list             # what each one measures and leaves out
npx vite-node src/games/fps/bench/run.ts -- --only snapshot --runs 5 --out src/games/fps/bench/results
npx vite-node src/games/fps/bench/run.ts -- --compare before.json after.json
```

Tests for the harness itself: `npx vitest run src/games/fps/bench`.

## Reading the output

```
snapshot.build   29.94  p95  42.64  p99  52.81  ±  1.32  us per call  entities=46 ...
```

Median, 95th and 99th percentile, and the spread **between runs** (± is the median absolute deviation of the run medians), all in the unit shown. The median run is reported, not the mean, because a garbage collection or a busy neighbour makes a few samples slow.

## Rules for comparing

- Same machine, same Node version, same settings. `--compare` **refuses** otherwise, and says why.
- A changed **checksum** (the deterministic scenarios) means behaviour changed, and is reported before any timing: a faster wrong answer is not an improvement.
- Treat differences under 10% as noise until you have seen the spread between runs on your machine (the `±`).
- Run it **before** an optimization, keep the file, and put both numbers in the commit message.

## Scenarios

| Name | Measures | Leaves out |
|------|----------|-----------|
| `snapshot.build` | `buildSnapshot`: 16 players, 20 projectiles, 10 dropped weapons, 8 damage events | per-client work |
| `snapshot.encode` | `BinaryProtocol.encodeSnapshot` of that, as a full snapshot | deltas, culling |
| `snapshot.buildAndEncode` | both together | per-client work |
| `snapshot.encodeClients16` | what the broadcaster does for 16 clients: one delta encode each | PVS culling, so an upper bound |
| `pickups.update` | `PickupSystem.update`: 16 players, 60 pickups, none in reach | actual pickups |
| `hitscan.resolve16` | one machinegun shot against 15 targets | collision, lag compensation |
| `sim.tick16` | one tick of movement, weapons, combat and projectiles, 16 players on seeded input | collision world, gametype, pickups |

Fixtures use the real subsystems, not mocks. `sim.tick16` is the deterministic re-simulation run one tick at a time and prints a checksum that must not change between runs.

## Not covered yet

Anything that needs the game's map files (a server with bots on a real map, client playback of a demo). See section 6 of the design document for the plan.

## Files

| File | Purpose |
|------|---------|
| `harness.ts` | Timing (`measureBatch`, `measureEach`), statistics, the result type |
| `compare.ts` | Comparing two results, and refusing when they cannot be compared |
| `fixtures.ts` | Seeded worlds and input logs |
| `scenarios.ts` | The scenarios above |
| `options.ts`, `run.ts` | The command line |
| `profile.ts` | Runs one scenario under the CPU profiler and prints self time per function: `npx vite-node src/games/fps/bench/profile.ts -- --scenario snapshot.encodeClients16 --seconds 5`. Use it to decide what to change, then confirm with `run.ts` |
| `__tests__/` | Tests for all of the above |
