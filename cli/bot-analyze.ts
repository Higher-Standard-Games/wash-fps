/** Deterministic headless bot map analysis and cache/report writer. */

import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { BotNavCacheStore } from "../bot/BotNavCache";
import {
  BOT_NAV_GRAPH_SCHEMA_VERSION,
  BOT_NAV_MOVEMENT_FINGERPRINT,
  BOT_NAV_TRIGGER_RESOLVER_VERSION,
  BotNavGraph,
} from "../bot/BotNavGraph";
import { createBotVision } from "../bot/BotVision";

const REPORT_SCHEMA_VERSION = 1;

function optionValue(args: string[], option: string): string | null {
  const index = args.indexOf(option);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function positionalMap(args: string[]): string | null {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--map" || arg === "--out") {
      index++;
      continue;
    }
    if (!arg.startsWith("-")) return arg;
  }
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: npm run bot:analyze -- --map <name> [--out <report.json>] [--rebuild] [--no-cache]");
    return;
  }

  const mapName = optionValue(args, "--map") ?? positionalMap(args) ?? "washoi_dm2";
  const outPath = optionValue(args, "--out");
  const rebuild = args.includes("--rebuild");
  const useCache = !args.includes("--no-cache");

  const visionStart = performance.now();
  const vision = await createBotVision(mapName);
  const visionMs = performance.now() - visionStart;
  if (!vision) throw new Error(`Unable to load BSP map "${mapName}"`);

  const cache = new BotNavCacheStore();
  let graph: BotNavGraph | null = null;
  let cacheHit = false;
  if (useCache && !rebuild) {
    graph = cache.load(mapName, vision.mapKnowledge.mapFingerprint);
    cacheHit = graph !== null;
    console.log(`[BotAnalyze] Cache ${cache.lastDiagnostic}`);
  }

  let analysisMs = 0;
  if (!graph) {
    graph = new BotNavGraph(mapName);
    const analysisStart = performance.now();
    graph.buildFromVision(vision);
    analysisMs = performance.now() - analysisStart;
    if (useCache) {
      cache.save(graph, vision.mapKnowledge.mapFingerprint);
      console.log(`[BotAnalyze] Cache ${cache.lastDiagnostic}`);
    }
  }

  const performedRollouts = cacheHit ? 0 : graph.movementAnalysis.rolloutCount;
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    mapName,
    bspHash: vision.mapKnowledge.mapFingerprint,
    graphSchemaVersion: BOT_NAV_GRAPH_SCHEMA_VERSION,
    triggerResolverVersion: BOT_NAV_TRIGGER_RESOLVER_VERSION,
    movementFingerprint: BOT_NAV_MOVEMENT_FINGERPRINT,
    generatedAt: new Date().toISOString(),
    cacheHit,
    nav: {
      nodes: graph.nodeCount,
      edges: graph.edgeCount,
      edgeTypes: Object.fromEntries(
        [...new Set(graph.edges.map((edge) => edge.type))]
          .sort()
          .map((type) => [type, graph.edges.filter((edge) => edge.type === type).length]),
      ),
    },
    opportunities: graph.movementOpportunities,
    rejected: graph.movementRejections,
    metrics: {
      ...graph.movementAnalysis,
      performedRollouts,
      visionMs: Number(visionMs.toFixed(3)),
      analysisMs: Number(analysisMs.toFixed(3)),
    },
  };

  if (outPath) {
    const absoluteOut = path.resolve(outPath);
    fs.mkdirSync(path.dirname(absoluteOut), { recursive: true });
    fs.writeFileSync(absoluteOut, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`[BotAnalyze] Report ${absoluteOut}`);
  }

  console.log(
    `[BotAnalyze] ${mapName}: nodes=${graph.nodeCount}, edges=${graph.edgeCount}, ` +
      `candidates=${graph.movementAnalysis.candidateCount}, rollouts=${performedRollouts}, ` +
      `accepted=${graph.movementAnalysis.acceptedCount}, rejected=${graph.movementAnalysis.rejectedCount}, ` +
      `analysis=${analysisMs.toFixed(1)}ms, cacheHit=${cacheHit}`,
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(`[BotAnalyze] ${(error as Error).message}`);
  process.exit(1);
});
