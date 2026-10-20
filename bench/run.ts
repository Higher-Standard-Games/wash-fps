/**
 * Run the benchmark scenarios.
 *
 * From the engine's root, with this game copied into src/games/fps:
 *
 *   npx vite-node src/games/fps/bench/run.ts
 *   npx vite-node src/games/fps/bench/run.ts -- --only snapshot --runs 5 --out src/games/fps/bench/results
 *   npx vite-node src/games/fps/bench/run.ts -- --compare before.json after.json
 *
 * Options:
 *   --only <text>      run only scenarios whose name contains the text
 *   --runs <n>         complete runs per scenario (default 3); the median run is reported
 *   --out <dir>        write one JSON file per scenario here
 *   --list             print the scenarios and stop
 *   --compare <a> <b>  compare two result files (baseline first) and stop
 *
 * What the numbers mean and how far to trust them: docs/research/performance-and-demos.md.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { devLog } from "../../../engine/core/DevLog";
import { compareResults, formatComparison } from "./compare";
import { type BenchResult, environment, medianOfRuns } from "./harness";
import { parseArgs } from "./options";
import { SCENARIOS, type Scenario, time } from "./scenarios";

function commit(): string {
  if (process.env.BENCH_COMMIT) return process.env.BENCH_COMMIT;
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

function runOnce(scenario: Scenario): BenchResult {
  const prepared = scenario.prepare();
  const startedAt = new Date().toISOString();
  const stats = time(prepared);
  return {
    schema: 1,
    name: scenario.name,
    unit: scenario.unit,
    commit: commit(),
    startedAt,
    environment: environment(),
    config: prepared.config,
    stats,
    extras: prepared.extras?.() ?? {},
    ...(prepared.checksum ? { checksum: prepared.checksum() } : {}),
  };
}

const f = (value: number) => value.toFixed(2).padStart(9);

function row(result: BenchResult): string {
  const extras = Object.entries(result.extras)
    .filter(([key]) => key !== "runs")
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  const checksum = result.checksum !== undefined ? ` checksum=${result.checksum}` : "";
  return `${result.name.padEnd(26)} ${f(result.stats.median)}  p95 ${f(result.stats.p95)}  p99 ${f(result.stats.p99)}  ±${f(result.stats.mad)}  ${result.unit}  ${extras}${checksum}`;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  if (options.compare) {
    const [a, b] = options.compare.map((file) => JSON.parse(fs.readFileSync(file, "utf8")) as BenchResult);
    devLog(formatComparison(compareResults(a, b)));
    return;
  }

  const chosen = SCENARIOS.filter((scenario) => !options.only || scenario.name.includes(options.only));
  if (options.list) {
    for (const scenario of chosen) devLog(`${scenario.name.padEnd(26)} ${scenario.description}\n`);
    return;
  }

  const env = environment();
  devLog(`${env.cpu} (${env.cores} cores), Node ${env.node}, ${options.runs} runs each, commit ${commit()}\n`);
  if (options.out) fs.mkdirSync(options.out, { recursive: true });

  for (const scenario of chosen) {
    const runs = Array.from({ length: options.runs }, () => runOnce(scenario));
    const result = medianOfRuns(runs);
    if (new Set(runs.map((run) => run.checksum)).size > 1) {
      console.error(`!! ${scenario.name}: the checksum differs between runs, so the workload is not deterministic`);
    }
    devLog(row(result));
    if (options.out)
      fs.writeFileSync(path.join(options.out, `${scenario.name}.json`), `${JSON.stringify(result, null, 2)}\n`);
  }
}

main();
