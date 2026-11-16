/**
 * A map's nav graph when the disk cache has none: built in a worker thread
 * (BotNavWorker) where the bundled bot server has one beside it, so the bots
 * already playing keep sending their commands meanwhile. Run from source
 * (vite-node, as the bot tools are), there is no worker file, and the graph is
 * built here, in this thread.
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { background } from "../../../engine/core/AsyncErrors";
import { BotNavCacheStore } from "./BotNavCache";
import { BotNavGraph, type NavGraphStaticData } from "./BotNavGraph";
import type { BotVision } from "./BotVision";

/** The worker's file in the bundled bot server, built beside it by build-servers.mjs. */
const WORKER_FILE = "bot-nav-worker.mjs";

export function navWorkerFile(): string | null {
  const file = fileURLToPath(new URL(`./${WORKER_FILE}`, import.meta.url));
  return fs.existsSync(file) ? file : null;
}

/** Build `mapName`'s graph and write the disk cache; null when it could not be built. */
export async function buildNavGraph(mapName: string, vision: BotVision): Promise<BotNavGraph | null> {
  const workerFile = navWorkerFile();
  if (!workerFile) {
    const graph = new BotNavGraph(mapName);
    graph.buildFromVision(vision);
    const store = new BotNavCacheStore();
    store.save(graph, vision.mapKnowledge.mapFingerprint);
    console.log(`[BotServer] NavGraph cache ${store.lastDiagnostic}`);
    return graph;
  }
  const started = Date.now();
  const reply = await new Promise<{ graph?: NavGraphStaticData; cache?: string; error?: string }>((resolve) => {
    const worker = new Worker(workerFile, { workerData: { mapName } });
    worker.once("message", (message) => {
      resolve(message);
      background(worker.terminate(), "BotNavBuilder");
    });
    worker.once("error", (error) => resolve({ error: error.message }));
    worker.once("exit", (code) => resolve({ error: `worker exited with code ${code}` }));
  });
  if (!reply.graph) {
    console.warn(`[BotServer] NavGraph build for "${mapName}" failed: ${reply.error}`);
    return null;
  }
  const graph = new BotNavGraph(mapName);
  graph.loadStaticData(reply.graph);
  console.log(`[BotServer] NavGraph built in a worker in ${Date.now() - started} ms; cache ${reply.cache}`);
  return graph;
}
