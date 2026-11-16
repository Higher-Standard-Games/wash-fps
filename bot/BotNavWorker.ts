/**
 * A nav graph built in a worker thread: the bot server's event loop, which
 * every bot's commands go through, never waits on a build. Loads the map's
 * collision on its own, builds, writes the disk cache and posts the graph's
 * static data back (BotNavBuilder starts it).
 */

import { parentPort, workerData } from "node:worker_threads";
import { BotNavCacheStore } from "./BotNavCache";
import { BotNavGraph } from "./BotNavGraph";
import { createBotVision } from "./BotVision";

const { mapName } = workerData as { mapName: string };
try {
  const vision = await createBotVision(mapName);
  if (!vision) {
    parentPort?.postMessage({ error: `no collision for ${mapName}` });
  } else {
    const graph = new BotNavGraph(mapName);
    graph.buildFromVision(vision);
    const store = new BotNavCacheStore();
    store.save(graph, vision.mapKnowledge.mapFingerprint);
    parentPort?.postMessage({ graph: graph.exportStaticData(), cache: store.lastDiagnostic });
  }
} catch (error) {
  parentPort?.postMessage({ error: (error as Error).message });
}
