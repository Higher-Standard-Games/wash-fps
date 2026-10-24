# Washoi development diagnostics

Run these from the assembled SHAG root. This directory contains optional
development fixtures and historical investigation scripts, not application
entry points or mandatory regression gates. The assembled TypeScript and Biome
configuration excludes this directory, preserving the scope these files had
before they moved from outer `scripts/`, `experiments/` and `docs/research/`.
Existing application and test checks remain enabled.

## Water fixture

```powershell
node src/games/fps/scripts/diagnostics/water-visual-check.mjs
```

The driver serves `water-visual-scene.ts` through a private Vite server, opens a
disposable headless Chrome profile and checks WebGL readiness/errors before
capturing water views. Run the normal headless regressions first. It uses
ports 3017 and 9227 and a separate `temp/vite-water-check-cache`; ensure those
ports are free. `WATER_CHECK_BROWSER` selects the browser executable. Outputs
remain under `temp/water-visual-check*` relative to the assembled root.
Existing flags, including `--map=`, `--stock`, `--full`, `--app`, `--actors`
and `--self-reflection`, retain their behavior. This fixture composes Washoi
liquid/player presentation with SHAG rendering, so both driver and scene live
with the game.

## Historical probes

Run a probe with `npx vite-node
src/games/fps/scripts/diagnostics/historical/<filename>`.

| Filename | Status verified at the 2026-10-24 ownership move |
| --- | --- |
| `v0.9.23-review-repro.ts` | Passes fixed-invariant/reconciliation checks; not a complete correctness gate |
| `v0.9.29-quality-probe.ts` | Passes its input/preferences/demo-selection diagnostics |
| `v0.9.23-networking-repro.ts` | Stale: its PVS stub lacks `getCluster`, causing a packet assertion failure before completion |
| `v0.9.23-pickup-render-probe.ts` | Stale: imports removed engine `entities/EntityManager` and shared `bsp/PickupTable` paths |

The two stale probes failed the same way before relocation. Their historical
assertions are preserved rather than treated as evidence of current behavior.
Current automated regression coverage lives in the game's `__tests__`
directories and the assembled `npm run test:run` / headless commands.

## Solamphi experiment

```powershell
npx vite-node src/games/fps/scripts/diagnostics/solamphi1-verify.ts
```

Requires the experiment's published `solamphi1` map in the canonical PK3 index.
It checks authored tunnel, slime basin, escape stair, detail collision and
lettering invariants through the game's bot collision view. Input data and its
output report remain under the assembled experiment workspace; the report is
`experiments/shagged/solamphi1/refinement/collision-report.json`. The map was not
installed at this checkpoint, so end-to-end verification is not claimed.
