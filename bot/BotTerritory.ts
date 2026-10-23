import type { BotGameState, Vec3 } from "./BotGameState";
import { vec3Distance } from "./BotGameState";
import type { BotNavGraph, NavPathOptions } from "./BotNavGraph";
import type { BotVision } from "./BotVision";

/** Reachable upper-floor patrols, with recent destinations avoided to keep moving. */
export class BotTerritory {
  private target: { position: Vec3; until: number } | null = null;
  private readonly visited = new Map<number, number>();

  reset(): void {
    this.target = null;
  }

  choose(
    state: BotGameState,
    graph: BotNavGraph,
    vision: BotVision,
    options: NavPathOptions,
    center?: Vec3,
  ): Vec3 | null {
    const self = state.self.position;
    if (
      this.target &&
      state.tick < this.target.until &&
      vec3Distance(self, this.target.position) > 96 &&
      this.target.position.y >= self.y - 48 &&
      (!center || vec3Distance(center, this.target.position) <= 384)
    )
      return this.target.position;
    this.target = null;
    for (const [id, until] of this.visited) if (state.tick >= until) this.visited.delete(id);
    const enemy = [...state.lastKnownEnemyPositions.values()]
      .filter((entry) => state.tick - entry.tick < 625)
      .sort((a, b) => b.tick - a.tick)[0]?.position;
    const candidates = graph.nodes
      .filter((node) => node.type === "floor" || node.type === "spawn")
      .map((node) => ({ node, position: { ...node.position, y: node.position.y + (node.type === "floor" ? 24 : 0) } }))
      .filter(
        ({ node, position }) =>
          !this.visited.has(node.id) &&
          vec3Distance(self, position) >= 160 &&
          position.y >= self.y - 48 &&
          (!center || vec3Distance(center, position) <= 384),
      )
      .map((candidate) => {
        const cost = graph.estimateTravelCost(self, candidate.position);
        const sight = enemy && vision.canSeeFrom(candidate.position, enemy) ? 160 : 0;
        return { ...candidate, cost, score: (candidate.position.y - self.y) * 2.5 + sight - (cost ?? Infinity) * 0.08 };
      })
      .filter((candidate) => candidate.cost !== null && candidate.cost <= 5000)
      .sort((a, b) => b.score - a.score);
    for (const candidate of candidates.slice(0, 8)) {
      const path = graph.findPath(self, candidate.position, options);
      if (!path || path.steps.some((step) => step.type === "fall" && step.to.position.y < self.y - 96)) continue;
      this.visited.set(candidate.node.id, state.tick + 625);
      this.target = { position: candidate.position, until: state.tick + 1000 };
      return candidate.position;
    }
    return null;
  }
}
