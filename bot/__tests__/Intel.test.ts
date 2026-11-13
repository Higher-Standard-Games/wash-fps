/**
 * The bot-intel store and its baseline: reports in, a deterministic baseline
 * out, retention, and the payoffs the strategist starts from.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildBaseline, loadBaseline, payoffPriors, saveBaseline } from "../intel/IntelBaseline";
import { IntelStore, type MatchReport } from "../intel/IntelStore";
import type { Fight } from "../strategy/MatchRead";

function fight(over: Partial<Fight> = {}): Fight & { against: "human" | "bot" } {
  return {
    enemy: "player_2",
    startTick: 0,
    lastContactTick: 250,
    cell: "0,256",
    ownStackAtStart: 100,
    enemyStackAtStart: 150,
    dealt: 80,
    taken: 120,
    sawFirst: true,
    result: "death",
    against: "bot",
    ...over,
  };
}

function report(over: Partial<MatchReport> = {}): MatchReport {
  return {
    map: "washoi_dm5",
    gametype: "Duel",
    preset: "hard",
    behavior: "a".repeat(64),
    score: 5,
    bestOther: 3,
    deaths: 3,
    people: 0,
    fights: [fight(), fight({ result: "kill", cell: "512,0" }), fight({ result: "open" })],
    episodes: [
      { diagnosis: "understacked", strategy: "recover", reward: 1, seconds: 30 },
      { diagnosis: "understacked", strategy: "recover", reward: 0, seconds: 30 },
    ],
    ...over,
  };
}

describe("IntelStore and the baseline", () => {
  it("sums reports per cell and per strategy, leaving out fights still open", () => {
    const store = new IntelStore(":memory:");
    store.record(report());
    store.record(report({ fights: [fight({ result: "kill" })] }));
    const baseline = buildBaseline(store, "washoi_dm5");
    const duel = baseline.gametypes.Duel;
    expect(duel.matches).toBe(2);
    expect(duel.fights.find((f) => f.cell === "0,256")).toMatchObject({ n: 2, won: 0.5, lost: 0.5 });
    expect(duel.payoffs).toEqual([{ diagnosis: "understacked", strategy: "recover", n: 4, mean: 0.5 }]);
    store.close();
  });

  it("gives the same baseline from the same reports", () => {
    const a = new IntelStore(":memory:");
    const b = new IntelStore(":memory:");
    for (const store of [a, b]) {
      store.record(report());
      store.record(report({ map: "washoi_dm2" }));
    }
    expect(JSON.stringify(buildBaseline(a, "washoi_dm5"))).toBe(JSON.stringify(buildBaseline(b, "washoi_dm5")));
  });

  it("forgets matches older than 90 days", () => {
    const store = new IntelStore(":memory:");
    const now = Date.now();
    store.record(report(), now - 91 * 24 * 3600 * 1000);
    store.record(report(), now);
    store.purge(now);
    expect(store.maps()).toEqual([{ map: "washoi_dm5", gametype: "Duel", matches: 1 }]);
  });

  it("saves a baseline the strategist can read back as priors", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bot-intel-"));
    try {
      const store = new IntelStore(":memory:");
      store.record(report());
      saveBaseline(buildBaseline(store, "washoi_dm5"), root);
      const priors = payoffPriors(loadBaseline("washoi_dm5", "Duel", root));
      expect(priors.get("understacked:recover")).toEqual({ n: 2, mean: 0.5 });
      expect(loadBaseline("washoi_dm5", "FFA", root)).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a bot's match report", () => {
  it("is handed in once when the match goes to post-game, with opponents as human or bot", async () => {
    const { BotClient } = await import("../BotClient");
    const bot = new BotClient({ name: "Ramen", difficulty: "hard", chat: false });
    const inner = bot as unknown as {
      _gameState: import("../BotGameState").BotGameState;
      _vision: { mapKnowledge: { mapName: string } };
      _reportMatchEnd(): void;
    };
    inner._vision = { mapKnowledge: { mapName: "washoi_dm5" } };
    inner._gameState.selfEntityId = "player_1";
    inner._gameState.playerNames.set("player_1", "Ramen");
    inner._gameState.playerNames.set("player_2", "Player_5937");
    inner._gameState.matchState.gametypeName = "Duel";
    const reports: MatchReport[] = [];
    bot.on("matchReport", (r: MatchReport) => reports.push(r));
    for (const phase of [2, 2, 3, 3]) {
      inner._gameState.matchState.phase = phase;
      inner._reportMatchEnd();
    }
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ map: "washoi_dm5", gametype: "Duel", preset: "hard", people: 1 });
  });
});

describe("the bot server's report store", () => {
  it("records the report of any game bot it is given, lobby-invited ones included", async () => {
    const { BotServer } = await import("../BotServer");
    const { BotClient } = await import("../BotClient");
    const intel = new IntelStore(":memory:");
    const server = new BotServer(0, { intel });
    const bot = new BotClient({ name: "Ramen", difficulty: "hard", chat: false });
    // The hook both addBot and a lobby bot's onGameBotCreated call
    (server as unknown as { _recordReports(b: InstanceType<typeof BotClient>): void })._recordReports(bot);
    bot.emit("matchReport", report());
    expect(intel.maps()).toEqual([{ map: "washoi_dm5", gametype: "Duel", matches: 1 }]);
    intel.close();
  });
});
