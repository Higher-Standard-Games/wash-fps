import type { EditorDocumentData } from "../../../../engine/editor/EditorDocument";
import {
  type GameMapAnalysis,
  type MapReachabilityResult,
  registerGameMapAnalysis,
} from "../../../../engine/editor/server/GameMapAnalysis";

/**
 * Reachability of the published map. The player walk flood (steps, slides,
 * drops and fixed standing hops) supplies the verdict;
 * `bots` is the bots' navigation graph, which also needs to connect for bots
 * to find their way, and misses stairs and other paths a player can take.
 */
async function mapReachability(doc: EditorDocumentData, mapName: string): Promise<MapReachabilityResult> {
  const [{ createBotVision }, { BotNavGraph }, { analyzeReachability }, { playerReachability }] = await Promise.all([
    import("../../../../bot/BotVision"),
    import("../../../../bot/BotNavGraph"),
    import("../../../../engine/editor/api/Reachability"),
    import("../../../../engine/editor/server/PlayerReach"),
  ]);
  const vision = await createBotVision(mapName);
  if (!vision) return { player: { ok: false, error: `could not load the compiled map "${mapName}"` }, bots: null };
  const knowledge = vision.mapKnowledge;
  const player = playerReachability(
    {
      world: vision.collisionWorld,
      spawns: knowledge.spawnPoints,
      items: knowledge.pickupPositions.map((p) => ({ classname: p.classname, position: p.position })),
      triggers: knowledge.triggerVolumes,
    },
    doc,
  );
  const graph = new BotNavGraph(mapName);
  graph.buildFromVision(vision);
  const bots = analyzeReachability(graph.nodes, graph.edges, doc);
  return {
    player,
    bots: {
      ok: bots.ok,
      unreachableItems: bots.unreachableItems.map((i) => i.objectId ?? i.classname),
      cutOffSpawns: bots.cutOffSpawns.map((s) => s.objectId ?? s.classname),
      navNodes: graph.nodeCount,
      navEdges: graph.edgeCount,
    },
  };
}

export const fpsMapAnalysis: GameMapAnalysis = { mapReachability };

export function registerFpsMapAnalysis(): void {
  registerGameMapAnalysis(fpsMapAnalysis);
}
