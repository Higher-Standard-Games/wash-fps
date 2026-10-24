# Washoi benchmark recipes

Run these drivers from the assembled SHAG checkout root. Dependencies resolve
from that checkout's `node_modules`; this folder is not a separate npm package.

| npm command | Driver |
| --- | --- |
| `benchmark:fixture` | `create-fixture.mjs` |
| `benchmark:profile` | `profile-timedemo.mjs` |
| `benchmark:outlines` | `outline-comparison.mjs` |
| `benchmark:crowd` | `crowd-benchmark.mjs` |
| `benchmark:outline-proxy:build` | `build-outline-proxy.mjs` |
| `benchmark:server-memory` | `server-memory.mjs` |
| `test:runtime-equivalence` | `runtime-equivalence.mjs` |

`server-capacity.mjs` is a direct Node entry point without an npm command.
Generic CPU-profile, runtime-executable and browser instrumentation helpers
remain under SHAG's `scripts/benchmarks/`.

Run both sets of Node tests from the assembled root:

```sh
node --test scripts/benchmarks/__tests__/*.test.mjs src/games/fps/scripts/benchmarks/__tests__/*.test.mjs
```

Fixture recipes, browser crowd fixture, media and output locations are relative
to the assembled root. Outline-proxy regeneration needs the optional Vanguard
source asset named in its recipe; its test skips when that asset is absent.
Moving a driver changes its source fingerprint: existing receipts retain their
original generator paths and hashes, and are not evidence of timing equivalence
across the move.
