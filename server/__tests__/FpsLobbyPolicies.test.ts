import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { GameState } from "../../../../engine/network/core/GameState";
import { GameServerSpawner } from "../../../../lobby/GameServerSpawner";
import { LobbyServer } from "../../../../lobby/LobbyServer";
import { checkPlayerName, NAME_PATTERN } from "../../../../lobby/PlayerIdentity";
import { PlayerStore } from "../../../../lobby/PlayerStore";
import { SettingsStore } from "../../../../lobby/SettingsStore";
import type { DemoInfo } from "../../../../lobby/types";
import { resolveFPSDemoMap } from "../../client/DemoMapAliases";
import { judgeName } from "../../client/IdentityFields";
import { BOT_NAMES, isBotName } from "../../shared/bot/BotNames";
import { DemoRecorder } from "../DemoRecorder";

it("reserves every Washoi bot name consistently in browser and durable accounts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shag-fps-policy-"));
  const players = PlayerStore.open(dir, isBotName);
  try {
    const { account } = players.create();
    for (const base of BOT_NAMES) {
      for (const name of [base, base.toLowerCase(), `${base}_2`]) {
        const code = NAME_PATTERN.test(name) ? "name_reserved" : "name_invalid";
        expect(checkPlayerName(name, isBotName)).toBe(code);
        expect(players.rename(account.id, name)).toEqual({ ok: false, code });
        expect(judgeName(name).ok).toBe(false);
      }
    }
    for (const name of ["Ramenya", "Udon", "Soba"]) {
      expect(checkPlayerName(name, isBotName)).toBeNull();
      expect(players.rename(account.id, name).ok).toBe(true);
      expect(judgeName(name).ok).toBe(true);
    }
  } finally {
    players.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("applies Washoi aliases only to demo levelshots and leaves recording identity intact", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shag-fps-demo-policy-"));
  const players = new PlayerStore(":memory:");
  const settings = new SettingsStore(":memory:");
  try {
    const maps = ["washoidm2", "washoidm5", "washoidm11", "wdm2", "wfdm5", "wfdm11", "maps/OTHER.BSP"];
    for (const map of maps) {
      const recorder = new DemoRecorder({
        map,
        gametype: "ffa",
        tickRate: 125,
        snapshotRate: 63,
        outputDir: dir,
        minDurationMs: 0,
        matchId: `policy-${maps.indexOf(map)}`,
      });
      const state = new GameState();
      state.tick = 1;
      recorder.recordFrame(state);
      await recorder.stop();
    }
    for (const resolver of [undefined, resolveFPSDemoMap]) {
      const lobby = new LobbyServer(0, new GameServerSpawner(), { players, settings, resolveDemoMap: resolver });
      const scanner = lobby as unknown as { DEMO_DIR: string; _scanDemos(): void; _demoCache: DemoInfo[] };
      scanner.DEMO_DIR = dir;
      scanner._scanDemos();
      expect(scanner._demoCache).toHaveLength(maps.length);
      for (const demo of scanner._demoCache) {
        expect(maps).toContain(demo.map);
        const normalized = demo.map === "maps/OTHER.BSP" ? "other" : demo.map;
        const media = resolver ? resolveFPSDemoMap(demo.map) : normalized;
        expect(demo.levelshot).toBe(`/data/levelshots/${media}.jpg`);
      }
    }
  } finally {
    settings.close();
    players.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
