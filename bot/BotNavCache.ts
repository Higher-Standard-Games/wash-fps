import * as fs from "node:fs";
import * as path from "node:path";
import {
  BOT_NAV_GRAPH_SCHEMA_VERSION,
  BOT_NAV_MOVEMENT_FINGERPRINT,
  BOT_NAV_TRIGGER_RESOLVER_VERSION,
  BotNavGraph,
  type NavEdgeType,
  type NavGraphStaticData,
  type NavNodeType,
} from "./BotNavGraph";

interface BotNavCacheFile {
  schemaVersion: number;
  mapName: string;
  mapFingerprint: string;
  triggerResolverVersion: number;
  movementFingerprint: string;
  createdAt: string;
  graph: NavGraphStaticData;
}

const NODE_TYPES = new Set<NavNodeType>(["item", "spawn", "floor", "jumppad", "teleporter"]);
const EDGE_TYPES = new Set<NavEdgeType>(["walk", "jump", "fall", "jumppad", "teleporter"]);

function isFiniteVec3(value: unknown): value is { x: number; y: number; z: number } {
  if (!value || typeof value !== "object") return false;
  const vec = value as Record<string, unknown>;
  return (
    typeof vec.x === "number" &&
    Number.isFinite(vec.x) &&
    typeof vec.y === "number" &&
    Number.isFinite(vec.y) &&
    typeof vec.z === "number" &&
    Number.isFinite(vec.z)
  );
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOptionalFinite(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isTriggerMetadata(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const trigger = value as Record<string, unknown>;
  return (
    typeof trigger.id === "number" &&
    Number.isInteger(trigger.id) &&
    trigger.id >= 0 &&
    isFiniteVec3(trigger.min) &&
    isFiniteVec3(trigger.max) &&
    isFiniteVec3(trigger.dest) &&
    isOptionalFinite(trigger.destYaw)
  );
}

function isMovementOpportunity(value: unknown, nodeCount: number): boolean {
  if (!value || typeof value !== "object") return false;
  const opportunity = value as Record<string, unknown>;
  const takeoff = opportunity.takeoff as Record<string, unknown> | undefined;
  const landing = opportunity.landing as Record<string, unknown> | undefined;
  const inputPlan = opportunity.inputPlan as Record<string, unknown> | undefined;
  const risk = opportunity.risk as Record<string, unknown> | undefined;
  const yawRange = takeoff?.yawRange;
  return (
    typeof opportunity.id === "string" &&
    opportunity.kind === "jump" &&
    typeof opportunity.fromNodeId === "number" &&
    Number.isInteger(opportunity.fromNodeId) &&
    opportunity.fromNodeId >= 0 &&
    opportunity.fromNodeId < nodeCount &&
    typeof opportunity.toNodeId === "number" &&
    Number.isInteger(opportunity.toNodeId) &&
    opportunity.toNodeId >= 0 &&
    opportunity.toNodeId < nodeCount &&
    !!takeoff &&
    isFiniteVec3(takeoff.position) &&
    isNonNegativeFinite(takeoff.radius) &&
    isNonNegativeFinite(takeoff.minSpeed) &&
    isNonNegativeFinite(takeoff.maxSpeed) &&
    Array.isArray(yawRange) &&
    yawRange.length === 2 &&
    yawRange.every((entry) => typeof entry === "number" && Number.isFinite(entry)) &&
    !!landing &&
    isFiniteVec3(landing.position) &&
    isNonNegativeFinite(landing.radius) &&
    isFiniteVec3(landing.surfaceNormal) &&
    !!inputPlan &&
    isFiniteVec3(inputPlan.direction) &&
    isNonNegativeFinite(inputPlan.initialSpeed) &&
    typeof inputPlan.buttons === "number" &&
    Number.isInteger(inputPlan.buttons) &&
    isNonNegativeFinite(inputPlan.jumpTicks) &&
    isNonNegativeFinite(inputPlan.maxTicks) &&
    isNonNegativeFinite(opportunity.expectedTicks) &&
    isNonNegativeFinite(opportunity.successMargin) &&
    !!risk &&
    typeof risk.fallDamage === "boolean" &&
    typeof risk.requiresLedgeGrab === "boolean"
  );
}

function isMovementAnalysis(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const analysis = value as Record<string, unknown>;
  const rejectionCounts = analysis.rejectionCounts;
  return (
    isNonNegativeFinite(analysis.candidateCount) &&
    isNonNegativeFinite(analysis.rolloutCount) &&
    isNonNegativeFinite(analysis.acceptedCount) &&
    isNonNegativeFinite(analysis.rejectedCount) &&
    typeof analysis.budgetExhausted === "boolean" &&
    !!rejectionCounts &&
    typeof rejectionCounts === "object" &&
    Object.values(rejectionCounts).every(isNonNegativeFinite)
  );
}

function isStaticData(value: unknown): value is NavGraphStaticData {
  if (!value || typeof value !== "object") return false;
  const graph = value as Record<string, unknown>;
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.opportunities)) return false;
  const nodes = graph.nodes as unknown[];
  const edges = graph.edges as unknown[];
  const opportunities = graph.opportunities as unknown[];

  const nodesValid = nodes.every((entry, index) => {
    if (!entry || typeof entry !== "object") return false;
    const node = entry as Record<string, unknown>;
    return node.id === index && isFiniteVec3(node.position) && NODE_TYPES.has(node.type as NavNodeType);
  });
  const edgesValid = edges.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const edge = entry as Record<string, unknown>;
    const isTriggerEdge = edge.type === "teleporter" || edge.type === "jumppad";
    return (
      typeof edge.from === "number" &&
      Number.isInteger(edge.from) &&
      edge.from >= 0 &&
      edge.from < nodes.length &&
      typeof edge.to === "number" &&
      Number.isInteger(edge.to) &&
      edge.to >= 0 &&
      edge.to < nodes.length &&
      typeof edge.cost === "number" &&
      Number.isFinite(edge.cost) &&
      edge.cost >= 0 &&
      EDGE_TYPES.has(edge.type as NavEdgeType) &&
      (edge.opportunityId === undefined || typeof edge.opportunityId === "string") &&
      isOptionalFinite(edge.requiredSpeed) &&
      isOptionalFinite(edge.expectedTicks) &&
      isOptionalFinite(edge.successMargin) &&
      (edge.validated === undefined || typeof edge.validated === "boolean") &&
      (isTriggerEdge ? isTriggerMetadata(edge.trigger) : edge.trigger === undefined)
    );
  });
  const opportunitiesValid = opportunities.every((entry) => isMovementOpportunity(entry, nodes.length));
  const opportunityIds = new Set(opportunities.map((entry) => (entry as Record<string, unknown>).id as string));
  const referencesValid = edges.every((entry) => {
    const opportunityId = (entry as Record<string, unknown>).opportunityId;
    return opportunityId === undefined || opportunityIds.has(opportunityId as string);
  });
  return (
    nodesValid && edgesValid && opportunitiesValid && referencesValid && isMovementAnalysis(graph.movementAnalysis)
  );
}

/** Persistent cache used by the Node bot process for deterministic map graph probing. */
export class BotNavCacheStore {
  readonly rootDir: string;
  lastDiagnostic: string = "not used";

  constructor(rootDir: string = process.env.BOT_NAV_CACHE_DIR || path.resolve(".cache", "bots", "maps")) {
    this.rootDir = rootDir;
  }

  getCachePath(mapName: string): string {
    const safeName = mapName.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.rootDir, `${safeName}.json`);
  }

  load(mapName: string, mapFingerprint: string): BotNavGraph | null {
    const cachePath = this.getCachePath(mapName);
    if (!fs.existsSync(cachePath)) {
      this.lastDiagnostic = `miss: ${cachePath}`;
      return null;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as Partial<BotNavCacheFile>;
      if (parsed.schemaVersion !== BOT_NAV_GRAPH_SCHEMA_VERSION) {
        this.lastDiagnostic = `rejected schema: ${parsed.schemaVersion ?? "missing"}`;
        return null;
      }
      if (parsed.mapName !== mapName || parsed.mapFingerprint !== mapFingerprint) {
        this.lastDiagnostic = "rejected map fingerprint";
        return null;
      }
      if (parsed.triggerResolverVersion !== BOT_NAV_TRIGGER_RESOLVER_VERSION) {
        this.lastDiagnostic = `rejected trigger resolver: ${parsed.triggerResolverVersion ?? "missing"}`;
        return null;
      }
      if (parsed.movementFingerprint !== BOT_NAV_MOVEMENT_FINGERPRINT) {
        this.lastDiagnostic = "rejected movement fingerprint";
        return null;
      }
      if (!isStaticData(parsed.graph)) {
        this.lastDiagnostic = "rejected malformed graph";
        return null;
      }

      const graph = new BotNavGraph(mapName);
      graph.loadStaticData(parsed.graph);
      this.lastDiagnostic = `hit: ${graph.nodeCount} nodes, ${graph.edgeCount} edges`;
      return graph;
    } catch (error) {
      this.lastDiagnostic = `rejected unreadable cache: ${(error as Error).message}`;
      return null;
    }
  }

  save(graph: BotNavGraph, mapFingerprint: string): boolean {
    const cachePath = this.getCachePath(graph.mapName);
    const payload: BotNavCacheFile = {
      schemaVersion: BOT_NAV_GRAPH_SCHEMA_VERSION,
      mapName: graph.mapName,
      mapFingerprint,
      triggerResolverVersion: BOT_NAV_TRIGGER_RESOLVER_VERSION,
      movementFingerprint: BOT_NAV_MOVEMENT_FINGERPRINT,
      createdAt: new Date().toISOString(),
      graph: graph.exportStaticData(),
    };

    try {
      fs.mkdirSync(this.rootDir, { recursive: true });
      fs.writeFileSync(cachePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      this.lastDiagnostic = `saved: ${cachePath}`;
      return true;
    } catch (error) {
      this.lastDiagnostic = `save failed: ${(error as Error).message}`;
      return false;
    }
  }
}
