/**
 * Profile a scenario: run it under Node's CPU profiler and print where the time goes.
 *
 *   npx vite-node src/games/fps/bench/profile.ts -- --scenario snapshot.encodeClients16 --seconds 5
 *
 * Reports "self" time (in the function itself, not what it calls), grouped by function and file,
 * so the top lines are where an optimization would pay off. Also writes the raw `.cpuprofile`
 * (open it in Chrome DevTools, the Performance tab) when given `--out <file>`.
 *
 * A sampling profiler is a guide, not a measurement: use it to choose what to change, then
 * confirm the change with run.ts.
 */

import * as fs from "node:fs";
import { Session } from "node:inspector";
import { devLog } from "../../../engine/core/DevLog";
import { SCENARIOS } from "./scenarios";

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
}

interface CpuProfile {
  nodes: ProfileNode[];
  samples: number[];
  timeDeltas: number[];
}

/** Self time in microseconds per function, from a CPU profile. */
export function selfTimes(profile: CpuProfile): Array<{ name: string; where: string; micros: number }> {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const totals = new Map<string, { name: string; where: string; micros: number }>();
  profile.samples.forEach((id, index) => {
    const node = byId.get(id);
    if (!node) return;
    const { functionName, url, lineNumber } = node.callFrame;
    const name = functionName || "(anonymous)";
    const file = url.split("/").slice(-3).join("/");
    const where = file ? `${file}:${lineNumber + 1}` : "(native)";
    const key = `${name}@${where}`;
    const entry = totals.get(key) ?? { name, where, micros: 0 };
    entry.micros += profile.timeDeltas[index] ?? 0;
    totals.set(key, entry);
  });
  return [...totals.values()].sort((a, b) => b.micros - a.micros);
}

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main(): Promise<void> {
  const name = arg("--scenario");
  const seconds = Number(arg("--seconds", "5"));
  const top = Number(arg("--top", "25"));
  const out = arg("--out");
  const scenario = SCENARIOS.find((candidate) => candidate.name === name);
  if (!scenario) {
    console.error(`Unknown scenario "${name}". Choose one of: ${SCENARIOS.map((s) => s.name).join(", ")}`);
    process.exit(1);
  }

  const prepared = scenario.prepare();
  for (let i = 0; i < 300; i++) prepared.run(); // warm up before profiling

  const session = new Session();
  session.connect();
  const post = <T>(method: string, params?: object): Promise<T> =>
    new Promise((resolve, reject) =>
      session.post(method, params ?? {}, (error, result) => (error ? reject(error) : resolve(result as T))),
    );

  await post("Profiler.enable");
  await post("Profiler.setSamplingInterval", { interval: 100 }); // microseconds
  await post("Profiler.start");
  const end = performance.now() + seconds * 1000;
  let calls = 0;
  while (performance.now() < end) {
    prepared.run();
    calls++;
  }
  const { profile } = await post<{ profile: CpuProfile }>("Profiler.stop");
  session.disconnect();

  if (out) fs.writeFileSync(out, JSON.stringify(profile));
  const rows = selfTimes(profile);
  const total = rows.reduce((sum, row) => sum + row.micros, 0);
  devLog(
    `${scenario.name}: ${calls} calls in ${seconds}s, ${(total / calls).toFixed(1)} us of sampled time per call\n`,
  );
  for (const row of rows.slice(0, top)) {
    const share = ((row.micros / total) * 100).toFixed(1).padStart(5);
    devLog(`${share}%  ${(row.micros / calls).toFixed(2).padStart(8)} us/call  ${row.name}  ${row.where}`);
  }
}

// Only when run as a script, so tests can import selfTimes.
if (process.argv.some((value) => value === "--scenario")) void main();
