/** Explicit integration smoke: real child process, ticketed clients, final report and SQLite. */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MessageType } from "../../../../../engine/network/protocol/BinaryProtocol";
import { MessageCodec } from "../../../../../engine/network/protocol/MessageCodec";
import { GameServerSpawner } from "../../../../../lobby/GameServerSpawner";
import { LobbyServer } from "../../../../../lobby/LobbyServer";
import { MatchResultStore } from "../../../../../lobby/MatchResultStore";
import { PlayerStore } from "../../../../../lobby/PlayerStore";
import type { ResultContext } from "../../../../../lobby/ResultSnapshot";
import { FPS_SERVER_APPLICATION } from "../../FpsServerApplication";
import { ProtocolTestClient } from "../_protocolTestClient";

async function unusedPort(): Promise<number> {
  const socket = net.createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return port;
}

describe("spawned match result handoff", () => {
  it("records a completed ticketed FFA draw from a real dedicated child", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shag-result-child-"));
    const accounts = PlayerStore.open(dir);
    const ids = [accounts.create().account.id, accounts.create().account.id];
    const results = MatchResultStore.open(dir);
    const spawner = new GameServerSpawner(await unusedPort(), FPS_SERVER_APPLICATION);
    const lobby = new LobbyServer(0, spawner, { players: accounts, results });
    const clients: ProtocolTestClient[] = [];
    const priorTime = process.env.SHAG_TIMELIMIT;
    const priorWarmup = process.env.SHAG_WARMUP;
    try {
      process.env.SHAG_TIMELIMIT = "1s";
      process.env.SHAG_WARMUP = "10s";
      const server = await spawner.spawn({
        map: "result_smoke_open_space",
        gametype: "ffa",
        maxClients: 2,
        admissionSeats: [
          { lobbyPlayerId: "one", accountId: ids[0], name: "One", team: "ffa", isBot: false },
          { lobbyPlayerId: "two", accountId: ids[1], name: "Two", team: "ffa", isBot: false },
        ],
      });
      // A running match carries both what room it belongs to and whether the
      // roster it started with was ranked (isRankedRoster; two humans here).
      const running = lobby as unknown as {
        matchToLobby: Map<string, string>;
        matchRecords: Map<string, ResultContext>;
      };
      running.matchToLobby.set(server.matchId, "room-smoke");
      running.matchRecords.set(server.matchId, {
        ranked: true,
        private: false,
        bots: 0,
        startingRoster: ids.map((accountId) => ({ accountId, isBot: false, team: "ffa" })),
      });
      const first = await ProtocolTestClient.connect(server.port);
      const second = await ProtocolTestClient.connect(server.port);
      clients.push(first, second);
      for (const [client, id] of [
        [first, "one"],
        [second, "two"],
      ] as const) {
        client.send(MessageCodec.encodeJoin(id, false, server.admissionTickets!.get(id)));
        await client.waitForType(MessageType.JoinAccept);
        client.send(MessageCodec.encodeJoinGame("ffa"));
      }
      first.send(MessageCodec.encodeReady());
      second.send(MessageCodec.encodeReady());
      await vi.waitFor(
        () => {
          expect(results.leaderboard({ gametype: "ffa", period: "all", offset: 0, limit: 10 }).total).toBe(2);
        },
        { timeout: 15_000, interval: 100 },
      );
      const page = results.leaderboard({ gametype: "ffa", period: "all", offset: 0, limit: 10 });
      expect(page.entries).toMatchObject([
        { accountId: ids[0], draws: 1 },
        { accountId: ids[1], draws: 1 },
      ]);
      expect(results.ratings.getResult(server.matchId)?.receipt).toMatchObject({
        recordStatus: "recorded",
        ratingStatus: "applied",
        ratingReason: "eligible",
      });
      expect(results.ratings.getResult(server.matchId)?.snapshot.seats).toHaveLength(2);
      expect(results.ratings.verifyReplay()).toEqual({ consistent: true, matches: 1, updates: 2, ratings: 2 });
    } finally {
      if (priorTime === undefined) delete process.env.SHAG_TIMELIMIT;
      else process.env.SHAG_TIMELIMIT = priorTime;
      if (priorWarmup === undefined) delete process.env.SHAG_WARMUP;
      else process.env.SHAG_WARMUP = priorWarmup;
      await Promise.all(clients.map((client) => client.close()));
      await spawner.shutdownAll();
      results.close();
      accounts.close();
      const target = path.resolve(dir);
      const root = path.resolve(os.tmpdir());
      if (target.startsWith(`${root}${path.sep}`) && path.basename(target).startsWith("shag-result-child-"))
        fs.rmSync(target, { recursive: true, force: true });
    }
  }, 45_000);
});
