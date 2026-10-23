import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { GameState } from "../../../../../engine/network/core/GameState";
import { humanSnapshot } from "../../../../../lobby/__tests__/_humanSnapshot";
import { GameServerSpawner } from "../../../../../lobby/GameServerSpawner";
import { LobbyServer, MIN_LISTED_DEMO_MS } from "../../../../../lobby/LobbyServer";
import { MatchResultStore } from "../../../../../lobby/MatchResultStore";
import { PlayerStore } from "../../../../../lobby/PlayerStore";
import type { DemoInfo } from "../../../../../lobby/types";
import { DemoRecorder } from "../../DemoRecorder";

it("publishes demo ownership only when ticketed accounts match a durable result", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shag-demo-owner-"));
  const demoDir = path.join(dir, "demos");
  const accounts = PlayerStore.open(dir);
  const results = MatchResultStore.open(dir);
  try {
    const first = accounts.create().account;
    const second = accounts.create().account;
    const bystander = accounts.create().account;
    const saved = new DemoRecorder({
      map: "wdm2",
      gametype: "deathmatch",
      matchId: "verified-match",
      tickRate: 125,
      snapshotRate: 63,
      outputDir: demoDir,
      minDurationMs: 0,
    });
    saved.addPlayer("1", first.name, "", first.id);
    saved.addPlayer("2", second.name, "", second.id);
    const state = new GameState();
    state.tick = 1;
    saved.recordFrame(state);
    const savedPath = await saved.stop();
    results.record({
      matchId: "verified-match",
      gametype: "ffa",
      map: "wdm2",
      endedAt: Date.now(),
      participants: [
        { accountId: first.id, outcome: "draw", score: 0 },
        { accountId: second.id, outcome: "draw", score: 0 },
      ],
    });

    const namesOnly = new DemoRecorder({
      map: "wdm7",
      gametype: "deathmatch",
      matchId: "unverified-match",
      tickRate: 125,
      snapshotRate: 63,
      outputDir: demoDir,
      minDurationMs: 0,
    });
    namesOnly.addPlayer("1", first.name);
    namesOnly.addPlayer("2", second.name);
    namesOnly.recordFrame(state);
    await namesOnly.stop();

    const privateDemo = new DemoRecorder({
      map: "wdm2",
      gametype: "ffa",
      matchId: "private-match",
      private: true,
      tickRate: 125,
      snapshotRate: 63,
      outputDir: demoDir,
      minDurationMs: 0,
    });
    privateDemo.addPlayer("1", first.name, "", first.id);
    privateDemo.addPlayer("2", "Bot", "");
    privateDemo.recordFrame(state);
    const privatePath = await privateDemo.stop();
    results.record({
      matchId: "private-match",
      gametype: "ffa",
      map: "wdm2",
      endedAt: Date.now(),
      private: true,
      bots: 1,
      participants: [{ accountId: first.id, outcome: "loss", score: 0 }],
    });

    const lobby = new LobbyServer(0, new GameServerSpawner(), { players: accounts, results });
    const scanner = lobby as unknown as {
      DEMO_DIR: string;
      _scanDemos(): void;
      _demoCache: DemoInfo[];
      _demoOwnership: Map<string, Set<number>>;
      handleDemosList(player: object, limit: number, scope: string): void;
      handleFeaturedGet(player: object, query: object): void;
    };
    scanner.DEMO_DIR = demoDir;
    scanner._scanDemos();
    expect(scanner._demoCache.find((demo) => demo.filename === path.basename(savedPath))?.levelshot).toBe(
      "/data/levelshots/wdm2.jpg",
    );
    expect(scanner._demoOwnership.get(path.basename(savedPath))).toEqual(new Set([first.id, second.id]));
    expect(scanner._demoOwnership.size).toBe(2);
    expect(scanner._demoOwnership.get(path.basename(privatePath))).toEqual(new Set([first.id]));
    expect(scanner._demoCache.find((demo) => demo.filename === path.basename(privatePath))?.private).toBe(true);
    expect(scanner._demoCache.find((demo) => demo.filename === path.basename(savedPath))).not.toHaveProperty(
      "verifiedAccountIds",
    );

    const pages: Array<{ scope: string; demos: DemoInfo[] }> = [];
    const reader = (accountId: number) => ({
      id: `reader-${accountId}`,
      accountId,
      ws: { readyState: 1, send: (raw: string) => pages.push(JSON.parse(raw)) },
    });
    // One-frame recordings are too short for any list, the owner's own included.
    scanner.handleDemosList(reader(first.id), 64, "yours");
    expect(pages.at(-1)).toMatchObject({ scope: "yours", demos: [] });
    scanner.handleDemosList(reader(bystander.id), 64, "latest");
    expect(pages.at(-1)?.demos).toEqual([]);
    for (const demo of scanner._demoCache) demo.durationMs = MIN_LISTED_DEMO_MS;
    scanner.handleDemosList(reader(first.id), 64, "yours");
    expect(pages.at(-1)?.demos.map((demo) => demo.filename)).toEqual(
      expect.arrayContaining([path.basename(savedPath), path.basename(privatePath)]),
    );
    expect(pages.at(-1)?.demos[0]).not.toHaveProperty("verifiedAccountIds");
    scanner.handleDemosList(reader(bystander.id), 64, "yours");
    expect(pages.at(-1)).toMatchObject({ scope: "yours", demos: [] });
    scanner.handleDemosList(reader(bystander.id), 64, "latest");
    expect(pages.at(-1)?.demos).toHaveLength(3);

    const verified = scanner._demoCache.find((demo) => demo.filename === path.basename(savedPath));
    if (!verified) throw new Error("Expected the verified recording in the scan");
    verified.durationMs = 150_000;
    verified.date = Date.now() - 1_000;
    const privateEntry = scanner._demoCache.find((demo) => demo.filename === path.basename(privatePath))!;
    privateEntry.durationMs = 150_000;
    privateEntry.date = Date.now();
    // A durable legacy record alone proves ownership, but grants no skill rank.
    scanner.handleFeaturedGet(reader(first.id), { type: "featured:get", requestId: "records-only", limit: 5 });
    expect(pages.at(-1)).toMatchObject({ selection: "recent_multiplayer_week" });
    results.ratings.ingest(humanSnapshot("skill-match", [first.id, second.id], Date.now(), "ffa"));
    scanner.handleFeaturedGet(reader(first.id), { type: "featured:get", requestId: "ranked", limit: 5 });
    expect(pages.at(-1)).toMatchObject({
      type: "featured:page",
      selection: "ranked_month_week",
      entries: [{ demo: { filename: path.basename(savedPath) }, reason: "Features a 30-day top 10 player" }],
    });
    expect(pages.at(-1)).not.toHaveProperty("entries.1");
    scanner._demoCache = [privateEntry];
    scanner.handleFeaturedGet(reader(first.id), { type: "featured:get", requestId: "private-only", limit: 5 });
    expect(pages.at(-1)).toMatchObject({ type: "featured:page", entries: [], selection: "recent_multiplayer_week" });
  } finally {
    results.close();
    accounts.close();
    const target = path.resolve(dir);
    const tempRoot = path.resolve(os.tmpdir());
    if (target.startsWith(`${tempRoot}${path.sep}`) && path.basename(target).startsWith("shag-demo-owner-")) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
});

it("lists a deleted account's demos under [deleted account], on deletion and on every later scan", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shag-demo-owner-"));
  const demoDir = path.join(dir, "demos");
  const accounts = PlayerStore.open(dir);
  try {
    const gone = accounts.create();
    const stays = accounts.create().account;
    const recorder = new DemoRecorder({
      map: "wdm2",
      gametype: "ffa",
      matchId: "deleted-player-match",
      tickRate: 125,
      snapshotRate: 63,
      outputDir: demoDir,
      minDurationMs: 0,
    });
    recorder.addPlayer("1", gone.account.name, "", gone.account.id);
    recorder.addPlayer("2", stays.name, "", stays.id);
    recorder.addPlayer("3", "Ramen", "");
    const state = new GameState();
    state.tick = 1;
    recorder.recordFrame(state);
    await recorder.stop();

    const lobby = new LobbyServer(0, new GameServerSpawner(), { players: accounts });
    const scanner = lobby as unknown as {
      DEMO_DIR: string;
      _scanDemos(): void;
      _demoCache: DemoInfo[];
      handleIdentityDelete(player: object, key: unknown, confirmed: unknown): void;
    };
    scanner.DEMO_DIR = demoDir;
    scanner._scanDemos();
    expect(scanner._demoCache[0].players).toEqual([gone.account.name, stays.name, "Ramen"]);

    const ws = { readyState: 1, send: () => {}, close: () => {} };
    scanner.handleIdentityDelete(
      { id: "p_1", accountId: gone.account.id, lobbyId: null, address: "x", ws },
      gone.key,
      true,
    );
    expect(scanner._demoCache[0].players).toEqual(["[deleted account]", stays.name, "Ramen"]);
    scanner._scanDemos();
    expect(scanner._demoCache[0].players).toEqual(["[deleted account]", stays.name, "Ramen"]);
  } finally {
    accounts.close();
    const target = path.resolve(dir);
    const tempRoot = path.resolve(os.tmpdir());
    if (target.startsWith(`${tempRoot}${path.sep}`) && path.basename(target).startsWith("shag-demo-owner-")) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
});
