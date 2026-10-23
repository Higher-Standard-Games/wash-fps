import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BotNavCacheStore } from "../BotNavCache";
import {
  BOT_NAV_GRAPH_SCHEMA_VERSION,
  BOT_NAV_MOVEMENT_FINGERPRINT,
  BOT_NAV_TRIGGER_RESOLVER_VERSION,
  BotNavGraph,
} from "../BotNavGraph";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createStore(): BotNavCacheStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shag-bot-nav-"));
  tempRoots.push(root);
  return new BotNavCacheStore(root);
}

function createGraph(): BotNavGraph {
  const graph = new BotNavGraph("wdm2");
  graph.loadStaticData({
    nodes: [
      { id: 0, type: "spawn", position: { x: 0, y: 0, z: 0 } },
      { id: 1, type: "jumppad", position: { x: 100, y: 0, z: 0 } },
      { id: 2, type: "item", classname: "item_armor_body", position: { x: 100, y: 256, z: 400 } },
    ],
    edges: [
      { from: 0, to: 1, type: "walk", cost: 100 },
      {
        from: 1,
        to: 2,
        type: "jumppad",
        cost: 220,
        trigger: {
          id: 7,
          min: { x: 80, y: -16, z: -16 },
          max: { x: 120, y: 16, z: 16 },
          dest: { x: 100, y: 256, z: 400 },
        },
      },
    ],
  });
  return graph;
}

function createAnalyzedGraph(): BotNavGraph {
  const graph = new BotNavGraph("wdm2");
  graph.loadStaticData({
    nodes: [
      { id: 0, type: "spawn", position: { x: 0, y: 24, z: 0 } },
      { id: 1, type: "item", classname: "item_health_mega", position: { x: 100, y: 64, z: 0 } },
    ],
    edges: [
      {
        from: 0,
        to: 1,
        type: "jump",
        cost: 130,
        opportunityId: "jump:0->1",
        requiredSpeed: 160,
        expectedTicks: 70,
        successMargin: 18,
        validated: true,
      },
    ],
    opportunities: [
      {
        id: "jump:0->1",
        kind: "jump",
        fromNodeId: 0,
        toNodeId: 1,
        takeoff: {
          position: { x: 0, y: 25, z: 0 },
          radius: 32,
          minSpeed: 160,
          maxSpeed: 160,
          yawRange: [1.45, 1.69],
        },
        landing: {
          position: { x: 100, y: 25, z: 0 },
          radius: 48,
          surfaceNormal: { x: 0, y: 1, z: 0 },
        },
        inputPlan: {
          direction: { x: 1, y: 0, z: 0 },
          initialSpeed: 160,
          buttons: 81,
          jumpTicks: 1,
          maxTicks: 150,
        },
        expectedTicks: 70,
        successMargin: 18,
        risk: { fallDamage: false, requiresLedgeGrab: false },
      },
    ],
    movementAnalysis: {
      candidateCount: 1,
      rolloutCount: 2,
      acceptedCount: 1,
      rejectedCount: 0,
      budgetExhausted: false,
      rejectionCounts: {},
    },
  });
  return graph;
}

describe("BotNavCacheStore", () => {
  it("round-trips validated static graph geometry", () => {
    const store = createStore();
    expect(store.save(createGraph(), "bsp-sha256")).toBe(true);

    const restored = store.load("wdm2", "bsp-sha256");
    expect(restored).not.toBeNull();
    expect(restored!.nodeCount).toBe(3);
    expect(restored!.edgeCount).toBe(2);
    expect(restored!.findPath({ x: 0, y: 0, z: 0 }, { x: 100, y: 256, z: 400 })?.steps[1]).toMatchObject({
      type: "jumppad",
      trigger: { id: 7, dest: { x: 100, y: 256, z: 400 } },
    });

    const payload = JSON.parse(fs.readFileSync(store.getCachePath("wdm2"), "utf8"));
    expect(payload.schemaVersion).toBe(BOT_NAV_GRAPH_SCHEMA_VERSION);
    expect(payload.movementFingerprint).toBe(BOT_NAV_MOVEMENT_FINGERPRINT);
    expect(payload.triggerResolverVersion).toBe(BOT_NAV_TRIGGER_RESOLVER_VERSION);
  });

  it("round-trips movement opportunities and edge execution metadata", () => {
    const store = createStore();
    expect(store.save(createAnalyzedGraph(), "bsp-sha256")).toBe(true);

    const restored = store.load("wdm2", "bsp-sha256");
    expect(restored).not.toBeNull();
    expect(restored!.movementOpportunities).toHaveLength(1);
    expect(restored!.movementOpportunities[0]).toMatchObject({
      id: "jump:0->1",
      expectedTicks: 70,
      successMargin: 18,
    });
    expect(restored!.edges[0]).toMatchObject({ opportunityId: "jump:0->1", requiredSpeed: 160, validated: true });
    expect(restored!.movementAnalysis).toMatchObject({ candidateCount: 1, rolloutCount: 2, acceptedCount: 1 });
  });

  it("rejects a graph generated from different BSP bytes", () => {
    const store = createStore();
    store.save(createGraph(), "old-bsp");

    expect(store.load("wdm2", "new-bsp")).toBeNull();
    expect(store.lastDiagnostic).toBe("rejected map fingerprint");
  });

  it.each([
    ["schemaVersion", -1, "rejected schema: -1"],
    ["triggerResolverVersion", -1, "rejected trigger resolver: -1"],
    ["movementFingerprint", "stale-movement", "rejected movement fingerprint"],
  ])("rejects stale %s metadata", (field, value, expectedDiagnostic) => {
    const store = createStore();
    store.save(createGraph(), "bsp-sha256");
    const cachePath = store.getCachePath("wdm2");
    const payload = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    payload[field] = value;
    fs.writeFileSync(cachePath, `${JSON.stringify(payload)}\n`, "utf8");

    expect(store.load("wdm2", "bsp-sha256")).toBeNull();
    expect(store.lastDiagnostic).toBe(expectedDiagnostic);
  });

  it("sanitizes map names used as cache filenames", () => {
    const store = createStore();
    expect(path.basename(store.getCachePath("../odd map"))).toBe("___odd_map.json");
  });
});
