# Performance Measurement and Demo-Based Benchmarks

**Status:** design, nothing implemented. Written for whoever builds it, so it records what already exists, what is missing, and a step-by-step plan.

**Why:** several of the [v0.9.25 QA items](./v0.9.25-QA.md) are optimizations (HUD change detection, pickup scans, snapshot allocation) and others need a regression check (item 6, item 8). Without repeatable numbers we cannot tell whether a change helped. The demo system gives us unusually good raw material for that, because it can replay a match deterministically.

**How this was written:** by reading source. Nothing here has been run. The code sketches are sketches, not tested code. Statements about cost ("cheap", "expensive") are guesses until measured.

---

## 1. What exists today

### 1.1 The demo system

| Piece | Where | What it does |
|-------|-------|--------------|
| **Recorder** | `server/DemoRecorder.ts` | Server-side. Records the whole match, from the start of the live phase through post-game, into a `.shagdemo`: header, frames, index table, footer. Format version **3**. Each frame is a **full, non-delta** `BinaryProtocol` snapshot, so any frame can be decoded alone (that is what makes seeking cheap) |
| **Applied commands** | `shared/demo/DemoInputs.ts` | Since version 3 the recording also keeps the **commands the server applied**: buttons, view angles, wish direction and weapon slot, per player, per frame. Buttons are OR-ed across the interval so a press between two snapshots is not lost |
| **Reader** | `shared/demo/DemoReader.ts` | `readHeader()`, `readIndex()`, `readFrame` / `seekFrame`, `readAllFrames()` |
| **Viewer** | `client/DemoViewer.ts` | Client-side playback. `load(data)`, `play()`, `seekToTick()`, `setSpeed()`, `update(deltaMs)` once per frame, `onFrame(cb)`. Speeds 0.25×, 0.5×, 1×, 2×, 4×. After a stall it delivers only the newest few frames (`MAX_FRAMES_PER_UPDATE`), so at high speed it skips frames rather than replaying them all |
| **Service** | `client/DemoService.ts` | Loads, lists, plays and analyses demos; drives the cinematic player. Console commands `demo`, `demolist`, `demoplay` |
| **Analyzer** | `shared/demo/DemoAnalyzer.ts` | Pure TypeScript. `analyze(frames, header, durationMs)` scans every frame for highlights; no rendering or network code |
| **Re-sim oracle** | `server/ReSim.ts` | `resimulate()` replays a usercmd log through the movement subsystem; `resimulateFull()` adds weapons, combat and projectiles. Both produce a **per-tick state checksum**. They need no map and no network |
| **Verify bundle** | `server/ReSimBundle.ts`, `demo:verify` | A `.shagverify` file: spawns, command log and golden checksums. `demo:verify` replays it and reports the first diverging tick |
| **Tests** | `server/__tests__/ReSim.test.ts`, `DemoRecorder.test.ts`, `DemoRecordingCapture.test.ts` | Determinism, tamper detection, recording gating |

See [Demos](../manual/multiplayer/demos.md) for the player-facing side.

### 1.2 Performance instrumentation that already exists

| What | Where | Output |
|------|-------|--------|
| **Tick-rate diagnostic** | `GameServer.ts:~700, ~780` | Every ~5 s: actual tick rate, ticks run, and the **maximum** tick work time (`diagMaxTickMs`). A log line, not data |
| **Per-client telemetry** | `server/Telemetry.ts`, `logClientTelemetry` | A structured `[Telemetry]` line per player about every 5 s: uplink jitter and loss, aim-flick signal, anti-warp strikes |
| **Catch-up logic** | `scheduleNextTick` | Up to 5 ticks to catch up after a stall (`MAX_CATCHUP`); a resync past that. A benchmark must count these |
| **Timing contract** | `server/ServerTiming.ts` | Tick, snapshot cadence (125 / 60 → every 2 ticks = 62.5 Hz) |
| **Logging façade** | `engine/core/Log.ts` (`log.debug/info/warn/error`) | Tags each message; it does **not** filter at run time (`log.debug` just calls `console.log`). Production *client* builds strip `console.log`/`console.debug`; the server is not stripped. Only 12 call sites in the game code use it |

### 1.3 Existing CLIs (engine repo, `src/cli/`)

| CLI | Use for benchmarking |
|-----|----------------------|
| `demo:record` (`record-demo.ts`) | Boots a real `GameServer` headlessly on a real map, adds N bots, runs S seconds. **The template for a server macro benchmark** |
| `server:fuzz` | Seeded random inputs into the simulation, checking for NaN and non-determinism |
| `net:viewlag` (`measure-viewlag.ts`) | Lag-compensation staleness over a real socket with held latency. Re-run it after any tick-rate, snapshot-rate or interpolation change |
| `bot:bench` | Cost of the neural bot overlay per decision |
| `demo:verify` | Re-sim bundle check |

### 1.4 What is missing

- **Machine-readable results.** Everything above prints text.
- **Distributions.** The tick diagnostic reports one maximum per 5 seconds; we need p50, p95 and p99.
- **Snapshot cost.** No timing of `buildSnapshot`, no byte counts per snapshot or per client.
- **GC and heap.** Nothing records collections or growth, which is how item 6's leak would show.
- **Any client measurement.**
- **Fixed scenarios and saved baselines.**
- **`vitest bench`.** No benchmark script is configured in the engine's `package.json`.

---

## 2. Demos as benchmark workloads

A benchmark needs a workload that is the **same every run**. Live matches with bots are not: bots are not deterministic and the network adds jitter. Demos and the re-sim oracle give us three workloads that are.

### 2.1 Server: re-simulation (needs no map and no bots)

`resimulateFull(spawns, log, ticks)` runs the real `FPSMovementSubsystem`, `WeaponSystem`, `CombatSystem` and `ProjectileSystem` through `Simulation.tick()`, with the same damage-forwarding order as `GameServer.tick`. It is **fully deterministic** and **asset-free**.

Limits, from its own header comment: no collision world, no gametype or respawns, no pickups. So it measures movement, weapon, combat and projectile cost, not collision tracing, which is likely the biggest cost in a real match (this is a guess).

As a benchmark: generate a seeded command log for 16 players, run it for N thousand ticks, time `sim.tick()` per tick. The final checksum doubles as a **correctness guard**: if an optimization changes it, behaviour changed.

```ts
// Sketch only. Not implemented or tested.
function syntheticLog(players: number, ticks: number, seed: number): RecordedCmd[] {
  const rng = mulberry32(seed);
  const log: RecordedCmd[] = [];
  for (let t = 0; t < ticks; t++) {
    for (let p = 1; p <= players; p++) {
      log.push({
        tick: t,
        entityId: p,
        cmd: {
          forward: rng() < 0.9 ? 1 : 0,
          right: rng() < 0.5 ? 1 : -1,
          pitch: 0,
          yaw: (t * 0.02 + p) % (Math.PI * 2),
          buttons: rng() < 0.3 ? FIRE : 0,
          sequence: t + 1,
          weaponSlot: 0,
        },
      });
    }
  }
  return log;
}
```

### 2.2 Server: a recorded demo's command track

Since version 3 a demo contains the commands the server applied. In principle a real recorded match (with a real map and real bots) can be replayed through the full server stack as a **deterministic macro workload**. The comment in `ReSimBundle.ts` says verifying a full `.shagdemo` "needs full-server re-sim (all subsystems + collision + event replay), a larger, separate extension." That extension is the prerequisite, and it is worth doing for the anti-cheat work as well as for benchmarking. Until then this is **not available**; use 2.1 and the bot scenarios (section 3).

### 2.3 Client: demo playback

`DemoViewer` plus the demo overlays drive the same render path as live play (entity interpolation, weapon view, effects, HUD). Playing a fixed `.shagdemo` is therefore a **deterministic client workload with no server, no bots and no network**. It is the cleanest way to measure client cost.

- Drive it from a browser script: `load(data)`, `setSpeed(1)`, `play()`, and let the normal frame loop call `update(deltaMs)`.
- Measure at **1×**. At 2× and 4× the viewer skips frames after a stall, so the work is not constant.
- A demo is recorded on a specific map, so playing it needs that map's files.

### 2.4 Client and tools: decode and analyse (needs no map)

- `DemoReader.readAllFrames()` is a pure decode benchmark of `BinaryProtocol.decodeSnapshot` over every frame.
- `new DemoAnalyzer().analyze(frames, header, durationMs)` is a pure CPU benchmark and is the one place the cinematic highlight detection is timed.

Both need a `.shagdemo` file but **no map and no renderer**, so they can run in plain Node.

### 2.5 Getting a demo to use

No demo is committed to either repo. Options:

| Option | Notes |
|--------|-------|
| **Record one** with `demo:record -- --map wdm2 --bots 2 --seconds 60 --gametype duel` | Needs map data. Gives a realistic fixture |
| **Synthesize one** by encoding a scripted `GameState` sequence through `DemoRecorder` | No map data. Good for decode and analyse benchmarks, not for render benchmarks. The recorder discards matches under about 10 seconds, so a fixture needs at least that |
| **Commit a small recorded fixture** | Check the size first: frames are full snapshots at about 62 per second. Measure a 30-second duel before deciding whether it can live in the repo or must be generated on demand |

Whatever we choose, record the fixture's map, gametype, length, frame count and checksum in a manifest next to it, so a changed fixture cannot silently change a baseline.

---

## 3. Workload catalogue

| ID | Workload | Needs | Deterministic | Measures |
|----|----------|-------|---------------|----------|
| **W0** | Synthetic re-sim, 16 players | nothing | yes | Simulation tick cost, movement + weapons + combat, checksum |
| **W1** | Micro benchmarks (see 4.2) | nothing | yes | One function each: `buildSnapshot`, `PickupSystem.update`, `HUDState.updateScoreboard`, hitscan |
| **W2** | Demo decode and analyse | a `.shagdemo` | yes | `decodeSnapshot`, `readAllFrames`, `DemoAnalyzer` |
| **W3** | Server with bots, real map | map data | no | Whole-server tick work, snapshot build, GC, heap |
| **W4** | Client demo playback | map data + browser | yes | Frame time, long tasks, HUD update cost, heap, listener count |
| **W5** | Full-server re-sim of a recorded demo | map data + the extension in 2.2 | yes | Everything in W3, deterministically |

**W3 scenarios** (built on `demo:record`):

| Scenario | Map / mode | Players | Why |
|----------|------------|--------:|-----|
| `duel` | `wdm2`, Duel | 2 bots | The lightest realistic match; a floor |
| `ffa8` | `wdm7`, Deathmatch | 8 bots | The lobby's FFA room size |
| `ffa16` | `wdm7`, Deathmatch | 16 bots | A full dedicated server; the stress case |
| `snd10` | `wbomb2`, Search & Destroy | 10 bots | Objective mode: rounds, bomb events |

Each runs 10 s of warm-up and then 60 s measured, with bots at a fixed difficulty (`hard`) and fixed names.

**Build order:** W0, W1 and W2 first. They need nothing we don't have and will answer most of the questions. W3 and W4 follow once map data is available.

---

## 4. What to measure, and where the hooks go

### 4.1 Server metrics

| Metric | Hook | Notes |
|--------|------|-------|
| **Tick work** | Wrap `this.tick()` in `scheduleNextTick` (`GameServer.ts:~699–703`), which already takes `t0` and computes the elapsed time for `diagMaxTickMs` | Record every sample into a fixed-size ring or a histogram. Do not allocate per tick |
| **Tick phases** | Inside `tick()`: movement validator, sim tick, lag-comp recording, combat forwarding, gametype `postTick`, snapshot build, broadcast, recording | Per-phase `performance.now()` deltas, behind a flag, so the benchmark can say which phase moved |
| **Snapshot build** | Around `buildSnapshot(snapshotCtx)` in `tick()` (`GameServer.ts:~935`) | Time and **entity count** |
| **Snapshot bytes** | `SnapshotBroadcaster.broadcast` | Bytes per snapshot, and per client after PVS culling and delta encoding |
| **Catch-up and stalls** | `scheduleNextTick` | Count of ticks run in a catch-up, and of resyncs. A run with resyncs is **invalid** |
| **GC** | `perf_hooks.PerformanceObserver` for `gc` entries | Count and total pause. Run with `--expose-gc` so we can force a collection between scenarios |
| **Heap** | `process.memoryUsage().heapUsed` | At start, end and peak; the shape over time is what shows a leak |
| **Event-loop delay** | `perf_hooks.monitorEventLoopDelay` | p99 delay; shows when other work starves the tick |

The hooks should be **off by default** and enabled by a config object passed to `GameServer` (for example `perf?: PerfSink`). When absent, the only cost is one optional-chaining check per tick.

### 4.2 Micro benchmark targets (W1)

| Benchmark | Fixture | Relates to |
|-----------|---------|-----------|
| `buildSnapshot` | 16 players, 20 projectiles, 10 dropped weapons, a few pending events | QA item 8 |
| Snapshot encode / decode | The same `GameState` through `BinaryProtocol` | QA item 8, W2 |
| `PickupSystem.update` | 16 players, 60 pickups, some inactive | QA item 7 |
| `HUDState.updateScoreboard` plus one pass over every widget (jsdom) | 16 scoreboard entries | QA item 2 |
| Hitscan resolution | 16 targets, one shooter, with and without a rewind | QA item 5 |
| Position cache loop (`GameServer.tick` step 0.5) | 100 entities | QA item 6 |

The engine has no `vitest bench` setup. Options: add `vitest bench` there (`*.bench.ts` files and a `bench` script), or write the micro benchmarks as plain scripts using `performance.now()` and a small harness (warm up, N iterations, report median and MAD). The plain script avoids touching the engine and is enough to start.

### 4.3 Client metrics (W4)

| Metric | How |
|--------|-----|
| **Frame time distribution** | `requestAnimationFrame` deltas; report p50, p95, p99 and the count over 2× the median |
| **Long tasks** | `PerformanceObserver` for `longtask` |
| **HUD update cost** | `performance.measure` around `FPSHud.update` (`FPSHud.ts:529`) |
| **JS heap** | `performance.memory.usedJSHeapSize` (Chromium only), sampled every second |
| **Listener count** | Chromium DevTools protocol `Memory.getDOMCounters` (`jsEventListeners`), sampled before and after joining a second match; proves QA item 3 |
| **Draw calls and scene size** | `scene.getActiveMeshes().length` and `engine.getFps()` (Babylon); useful context, not a target |

**Caveat:** headless Chromium renders with a software GPU, so absolute frame rates and anything GPU-bound mean nothing. Compare **JavaScript-side** numbers only, and only against runs on the same machine.

---

## 5. Result format

One JSON file per run, so results can be diffed by a script and stored.

```jsonc
{
  "schema": 1,
  "workload": "W0",                       // or "W3:ffa16", "W4:duel-demo"
  "commit": "abc1234",
  "dirty": false,
  "node": "v22.x",
  "cpu": "model, cores",
  "startedAt": "2026-10-06T12:00:00Z",
  "config": { "players": 16, "ticks": 20000, "seed": 1, "warmupTicks": 2000 },
  "valid": true,                          // false if a stall or resync happened
  "metrics": {
    "tickMs": { "p50": 0.0, "p95": 0.0, "p99": 0.0, "max": 0.0, "samples": 0 },
    "snapshotBuildMs": { "p50": 0.0, "p99": 0.0 },
    "snapshotBytes": { "p50": 0, "p99": 0 },
    "gc": { "count": 0, "totalPauseMs": 0 },
    "heapMB": { "start": 0, "end": 0, "peak": 0 }
  },
  "checksum": 0                           // W0, W5: the final state checksum
}
```

Rules:

- **Repeat 5 times** and store the median of each metric (plus the median absolute deviation), not a single run.
- **Warm up** first. The JIT changes the numbers for the first second or so.
- **Compare like with like:** same machine, same Node version, same workload config. The comparison script should refuse to diff files whose `node`, `cpu` or `config` differ.
- **Noise floor:** treat differences under about 10% as noise until we have measured the run-to-run spread on a real machine, then replace that number with the measured one.
- **Checksum:** for W0 and W5, a changed checksum means behaviour changed. That is a correctness failure, not a performance one, and the report should say so loudly.

### Baselines

Store baselines in `bench/baselines/<machine-id>.json`. Do not compare across machines. A change that claims a speedup puts before and after numbers in its commit message.

---

## 6. Implementation plan

**Status (2026-10-07):** steps 1, 2 (for the server items), 3 and the `sim.tick16` part of 4 are built, in `bench/` (see its README). Not started: the optional timing hook inside `GameServer` (step 4), the demo decode workload (step 5), and everything that needs map data (steps 6 to 8). The HUD micro benchmark is still a throwaway.

Each step is independently useful and should be its own commit.

| Step | Work | Needs | Done when |
|------|------|-------|-----------|
| 1 | **Harness**: a small `bench/harness.ts` with warm-up, repeat, median and MAD, percentile calculation and the JSON writer; `bench/compare.ts` to diff two files | nothing | Unit tests cover the statistics and the refusal to compare mismatched runs |
| 2 | **W1 micro benchmarks** for items 2, 7 and 8 (and 5, 6) | fixtures built by hand | Each prints a median and writes a result file. The numbers decide whether QA items 2, 7 and 8 are worth doing |
| 3 | **W0 synthetic re-sim** with a seeded log generator | nothing | Produces tick-time percentiles and a stable final checksum; two runs give the same checksum |
| 4 | **Optional perf sink in `GameServer`** (`PerfSink` interface; hooks in 4.1) | nothing | With no sink, behaviour and tick cost are unchanged; with one, W3 can read phase timings |
| 5 | **W2 decode and analyse**, with a synthesized demo | a `DemoRecorder` run on a scripted `GameState` | `readAllFrames` and `analyze` timings recorded |
| 6 | **W3 server scenarios** | map data; the engine's `vite-node` | The four scenarios run, report valid results, and a 5-run median has a spread we can state |
| 7 | **W4 client playback** | map data; Playwright and Chromium | Frame time, HUD cost and listener count reported for a fixed demo |
| 8 | **Full-server re-sim of a demo** (W5) | the 2.2 extension | A recorded demo replays through the full stack with matching checksums. Also a prerequisite for the anti-cheat plan |

### Where the code lives

- **This repo (`bench/`):** the harness, the workloads, the fixtures and manifests, the baselines, and the `PerfSink` hooks in `server/`.
- **Engine repo:** any `package.json` script entry (`bench:server`, `bench:micro`). Until that is added, scripts run directly with `npx vite-node bench/<file>.ts` from the engine checkout.
- **Imports:** this repo is a submodule, so scripts import from `../../../engine/...` and `../../../shared/...` like the rest of the game code. They cannot run outside the engine checkout.

### Running things in a cloud session

- Tests and micro benchmarks need the engine's dependencies. **This works:** clone the engine, `npm install --ignore-scripts`, and copy (not symlink) this repo into `src/games/fps`. The exact steps are in [v0.9.25-QA.md](./v0.9.25-QA.md#running-the-tests). Micro benchmarks written as plain scripts can run the same way with `npx vite-node`.
- Map data is not available in a cloud session, so W3, W4 and W5 can only be **written** there, not run.

---

## 7. Risks and open questions

| Risk or question | Notes |
|------------------|-------|
| **Observer effect** | `performance.now()` calls per tick and per phase have a cost. Measure the overhead of the sink itself (run W0 with and without) and keep phase timing opt-in |
| **Bot non-determinism** | W3 numbers vary between runs. The median-of-5 rule handles tick cost but not scenario content (a run with more fights costs more). Record kills and shots per run as covariates |
| **Synthetic workloads miss real costs** | W0 has no collision world. A fast W0 does not prove a fast server. W3 stays the final check |
| **Fixture drift** | Changing a weapon or movement constant changes W0's checksum and a demo's replay. The manifest should say which game version a fixture belongs to |
| **Demo version bumps** | A `damage.hitLocation` field (QA item 5) means a demo format change; fixtures and the W5 extension must be regenerated |
| **Hardware** | Absolute numbers depend on the machine. Is there a standard machine we can all use for baselines (a CI runner, or one designated developer machine)? |
| **CI** | Should regressions fail a build? Suggest not at first: publish the comparison as a report until the noise floor is known |
| **Where to keep baselines** | In the repo (reviewable, but changes with hardware) or as CI artifacts? |

## 7a. First measurements (HUD and server, recorded 2026-10-07)

**Server numbers** (snapshot build and encode, pickups, hitscan, a 16-player tick) are in [v0.9.25-QA.md](./v0.9.25-QA.md#first-server-measurements); they came from the harness in `bench/`. The headline: encoding one snapshot for each of 16 clients costs 2.4 ms, about 15% of a core, and is 80 times the cost of building the snapshot.

The first W1-style measurement, for the HUD, was taken by hand for QA item 2, as a throwaway test that timed each HUD widget's `update` 4,000 times in jsdom against an unchanged state, after 400 warm-up calls. It is **not** kept as a benchmark yet. It is the template for the HUD entry in the micro-benchmark table (section 4.2).

- **What it showed:** the whole HUD costs about 180 µs per 50 ms poll, almost all of it in two widgets that rewrote `innerHTML` every poll in warmup. The change-detection code the item was originally about (`JSON.stringify` signatures) cost under 1 µs on the weapon rack and about 5 µs on the scoreboard. Full table in [v0.9.25-QA.md](./v0.9.25-QA.md), item 2.
- **Lesson for the plan:** measure before designing. A micro benchmark took ten minutes to write and overturned the premise of a two-day design. This is the strongest argument for doing section 6, steps 1 and 2, before items 7 and 8.
- **Limits:** jsdom has no layout, no paint and no CSS animations, so it misses the real cost of a DOM rewrite. It is good at finding where JavaScript-side work is, not at saying what Chrome spends.

## 8. Related documents

- [v0.9.25-QA.md](./v0.9.25-QA.md): the items these measurements serve.
- [Demos](../manual/multiplayer/demos.md): recording, listing and playback from the player's side.
- [Demo Cinematic](../manual/tools/demo-cinematic.md): the analyzer.
- [Bot Server](../manual/tools/bot-server.md): the bots that drive W3.
