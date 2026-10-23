/** Recorded-position collision benchmark; this does not replay gameplay inputs. */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { BspLoader } from "../../../engine/loader/bsp/BspLoader";
import { resolveMapBspViaIndex } from "../../../engine/loader/pk3/NodePk3";
import type { TraceResult } from "../../../engine/physics/CollisionBackend";
import { SweepCollisionBackend } from "../../../engine/physics/SweepCollisionBackend";
import { DemoReader } from "../../../shared/demo/DemoReader";
import { resolveFPSDemoMap } from "../client/DemoMapAliases";

const args = process.argv.slice(2);
const value = (key: string) => {
  const argument = args[args.indexOf(key) + 1];
  if (!argument || argument.startsWith("--")) throw new Error(`Missing value for ${key}`);
  return argument;
};
const demoPath = args.includes("--demo")
  ? value("--demo")
  : "public/data/demos/training/wfdm11_performance_investigation_1.shagdemo";
const output = args.includes("--out") ? value("--out") : ".cache/collision-benchmark.json";
const baselinePath = args.includes("--baseline") ? value("--baseline") : undefined;
if (baselinePath && path.resolve(baselinePath) === path.resolve(output)) {
  throw new Error("Baseline and output must be different files");
}
const stride = args.includes("--stride") ? Number(value("--stride")) : 8;
if (!Number.isSafeInteger(stride) || stride < 1) throw new Error("--stride must be a positive integer");
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const raw = Uint8Array.from(fs.readFileSync(demoPath));
const reader = new DemoReader(raw[0] === 31 && raw[1] === 139 ? Uint8Array.from(gunzipSync(raw)) : raw);
const header = reader.readHeader();
const frames = reader.readAllFrames();
const bytes = await resolveMapBspViaIndex(["public/data", "dist/data"], resolveFPSDemoMap(header.map));
if (!bytes) throw new Error(`Indexed map missing: ${header.map}`);
const backend = new SweepCollisionBackend();
const beforeInit = performance.now();
await backend.init(BspLoader.load(bytes));
const initMs = performance.now() - beforeInit;
const traceValue = (r: TraceResult) => [
  r.fraction,
  r.endPos.asArray(),
  r.normal?.asArray() ?? null,
  r.startSolid,
  r.allSolid,
  r.contents,
  r.hitBrushIndex ?? null,
  r.hitTextureName ?? null,
];
const cases: { tick: number; start: Vector3; delta: Vector3 }[] = [];
for (let i = 1; i < frames.length; i += stride) {
  const player = frames[i].state.players.values().next().value;
  if (!player) continue;
  const previous = frames[i - 1].state.entities.get(player.entityId);
  const current = frames[i].state.entities.get(player.entityId);
  const a = previous?.getComponent("transform") as { position?: { x: number; y: number; z: number } } | undefined;
  const b = current?.getComponent("transform") as typeof a;
  if (!a?.position || !b?.position) continue;
  const start = new Vector3(a.position.x, a.position.y, a.position.z);
  cases.push({
    tick: frames[i].tick,
    start,
    delta: new Vector3(b.position.x, b.position.y, b.position.z).subtract(start),
  });
}
if (!cases.length) throw new Error("No player route samples");
const run = (sample: (typeof cases)[number]) => {
  const { start, delta } = sample;
  const end = start.add(delta);
  const move = backend.stepSlideMove(start, delta, { radius: 16, height: 64 });
  return [
    sample.tick,
    traceValue(backend.trace(start, end, { radius: 16, height: 64 })),
    traceValue(backend.trace(start, end, { radius: 16, height: 32 })),
    traceValue(backend.trace(start, end, { radius: 0, height: 0, contentMask: 1 })),
    traceValue(backend.trace(start, start.add(new Vector3(0, -80, 0)))),
    move.endPos.asArray(),
    move.velocity.asArray(),
    move.hitCount,
    move.stepped,
    traceValue(backend.trace(move.endPos, move.endPos.add(new Vector3(0, -2, 0)))),
  ];
};
// Warm the same workloads before collecting route timings.
for (const sample of cases) run(sample);
const results = cases.map(run);
const times = cases.map((sample) => {
  const now = performance.now();
  run(sample);
  return { tick: sample.tick, ms: performance.now() - now };
});
const sorted = times.map((t) => t.ms).sort((a, b) => a - b);
const identity = { demoHash: hash(raw), bspHash: hash(new Uint8Array(bytes)), stride, map: header.map };
const report = {
  identity,
  initMs,
  node: process.version,
  samples: cases.length,
  timing: {
    medianMs: sorted[Math.floor(sorted.length * 0.5)],
    p95Ms: sorted[Math.floor(sorted.length * 0.95)],
    p99Ms: sorted[Math.floor(sorted.length * 0.99)],
  },
  stats: backend.getStats(),
  times,
  results,
  limitations: "Node, recorded displacements; not full simulation, prediction replay or GPU/FPS measurement",
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, results: undefined, times: undefined }));
if (baselinePath) {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8")) as typeof report;
  if (JSON.stringify(baseline.identity) !== JSON.stringify(identity)) throw new Error("Baseline identity mismatch");
  if (baseline.results.length !== results.length) throw new Error("Baseline sample count mismatch");
  const differences = results.filter((r, i) => JSON.stringify(r) !== JSON.stringify(baseline.results[i]));
  console.log(`Differential: ${differences.length}/${results.length} changed samples`);
  if (differences.length) process.exitCode = 1;
}
backend.dispose();
