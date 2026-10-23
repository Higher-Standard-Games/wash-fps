/** Installed-map integration: lobby room -> child -> ticketed game -> ranking read. */
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { MessageType } from "../../../../../engine/network/protocol/BinaryProtocol";
import { MessageCodec } from "../../../../../engine/network/protocol/MessageCodec";
import { GameServerSpawner } from "../../../../../lobby/GameServerSpawner";
import { LobbyServer } from "../../../../../lobby/LobbyServer";
import { MatchResultStore } from "../../../../../lobby/MatchResultStore";
import { PlayerStore } from "../../../../../lobby/PlayerStore";
import type { GametypeInfo, MatchLobbyInfo } from "../../../../../lobby/types";
import { DemoReader } from "../../../../../shared/demo/DemoReader";
import { botReference } from "../../../../../shared/ranking/__tests__/_botReference";
import { FPS_SERVER_APPLICATION } from "../../FpsServerApplication";
import { ProtocolTestClient } from "../_protocolTestClient";

async function unusedPort(): Promise<number> {
  const socket = net.createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return port;
}

class LobbyPeer {
  private readonly messages: Array<Record<string, unknown>> = [];

  constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) => this.messages.push(JSON.parse(raw.toString())));
  }

  static async connect(port: number): Promise<LobbyPeer> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const peer = new LobbyPeer(socket);
    await once(socket, "open");
    return peer;
  }

  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message));
  }

  async waitFor(type: string, predicate: (message: Record<string, unknown>) => boolean = () => true, timeout = 5000) {
    return vi.waitFor(
      () => {
        const message = this.messages.find((candidate) => candidate.type === type && predicate(candidate));
        if (!message) throw new Error(`Waiting for ${type}; saw ${this.messages.map((item) => item.type).join(", ")}`);
        return message;
      },
      { timeout, interval: 50 },
    );
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = once(this.socket, "close");
    this.socket.close();
    await closed;
  }
}

const hasInstalledWdm2 = fs.existsSync(path.join(process.cwd(), "public", "data", "map_washoi_dm2.pk3"));

describe("installed-map room to ranking", () => {
  it.skipIf(!hasInstalledWdm2).each(["public", "private"] as const)(
    "launches washoi_dm2 from a real %s lobby and serves only the selected ranking",
    async (visibility) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shag-room-ranking-"));
      const target = path.resolve(dir);
      const root = path.resolve(os.tmpdir());
      if (!target.startsWith(`${root}${path.sep}`) || !path.basename(target).startsWith("shag-room-ranking-"))
        throw new Error(`Unsafe cleanup target: ${target}`);
      const accounts = PlayerStore.open(dir);
      const results = MatchResultStore.open(dir);
      const members = visibility === "private" ? [accounts.create()] : [accounts.create(), accounts.create()];
      const spawner = new GameServerSpawner(await unusedPort(), FPS_SERVER_APPLICATION);
      const spawn = vi.spyOn(spawner, "spawn");
      const botSecret = "ranking-smoke-secret";
      const lobby = new LobbyServer(0, spawner, { players: accounts, results, botSecret });
      const mapConfig = path.join(dir, "maps.json");
      fs.writeFileSync(mapConfig, JSON.stringify({ washoi_dm2: { displayName: "Test Arena", gametypes: ["ffa"] } }));
      (lobby as unknown as { MAP_CONFIG_PATH: string }).MAP_CONFIG_PATH = mapConfig;
      const peers: LobbyPeer[] = [];
      const gameClients: ProtocolTestClient[] = [];
      const demoDir = path.join(process.cwd(), "public", "data", "demos");
      const priorDemos = new Set(fs.existsSync(demoDir) ? fs.readdirSync(demoDir) : []);
      let recordedDemo: string | undefined;
      const priorTime = process.env.SHAG_TIMELIMIT;
      const priorWarmup = process.env.SHAG_WARMUP;
      try {
        process.env.SHAG_TIMELIMIT = visibility === "private" ? "11s" : "1s";
        process.env.SHAG_WARMUP = "10s";
        await lobby.start();
        // Shipped FFA needs four to start; two seats are enough to carry a result
        // here. Select one installed map for determinism.
        const internal = lobby as unknown as { gametypes: GametypeInfo[]; wss: { address(): { port: number } } };
        const ffa = internal.gametypes.find((mode) => mode.id === "ffa")!;
        expect(ffa).toMatchObject({ maxPlayers: 8, minPlayers: 4 });
        ffa.minPlayers = 2;
        expect(ffa.mapPool).toEqual(["washoi_dm2"]);
        const lobbyPort = internal.wss.address().port;
        for (const member of members) {
          const peer = await LobbyPeer.connect(lobbyPort);
          peers.push(peer);
          peer.send({ type: "auth", key: member.key });
          expect(await peer.waitFor("welcome")).toMatchObject({
            identity: { id: String(member.account.id) },
            features: { skillRatings: true },
          });
        }
        if (visibility === "private") {
          const peer = await LobbyPeer.connect(lobbyPort);
          peers.push(peer);
          peer.send({ type: "auth", isBot: true, botSecret, name: "Ranking Bot", botReference: botReference() });
          await peer.waitFor("welcome");
        }
        const [first, second] = peers;
        first.send({ type: "lobby:create", gametype: "ffa", visibility });
        const room = (await first.waitFor("lobby:created")).lobby as MatchLobbyInfo;
        expect(room.config).toMatchObject({ maxPlayers: 8, minPlayers: 2 });
        expect(room.maps).toMatchObject([{ name: "washoi_dm2" }]);
        first.send({ type: "lobby:ready", lobbyId: room.id, ready: true });
        await first.waitFor("lobby:player_updated", (message) => message.ready === true);
        expect(spawn).not.toHaveBeenCalled();
        const inviteToken = new URL(room.shareUrl, "https://example.invalid").searchParams.get("invite") ?? undefined;
        second.send({ type: "lobby:join", lobbyId: room.id, inviteToken });
        expect(await second.waitFor("lobby:created")).toMatchObject({ lobby: { id: room.id } });
        first.send({ type: "lobby:ready", lobbyId: room.id, ready: true });
        second.send({ type: "lobby:ready", lobbyId: room.id, ready: true });
        const [firstConnect, secondConnect] = await Promise.all([
          first.waitFor("lobby:connect", () => true, 45_000),
          second.waitFor("lobby:connect", () => true, 45_000),
        ]);
        expect(firstConnect).toMatchObject({ map: "washoi_dm2", gametype: "ffa" });
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(secondConnect).toMatchObject({ matchId: firstConnect.matchId, serverUrl: firstConnect.serverUrl });
        expect(firstConnect.admissionTicket).not.toBe(secondConnect.admissionTicket);
        expect(results.deliveries.has(String(firstConnect.matchId))).toBe(true);
        for (const [handoff, name] of [
          [firstConnect, "One"],
          [secondConnect, "Two"],
        ] as const) {
          const port = Number(new URL(String(handoff.serverUrl)).port);
          const client = await ProtocolTestClient.connect(port);
          gameClients.push(client);
          client.send(
            MessageCodec.encodeJoin(
              name,
              visibility === "private" && handoff === secondConnect,
              String(handoff.admissionTicket),
            ),
          );
          await client.waitForType(MessageType.JoinAccept);
          client.send(MessageCodec.encodeJoinGame("ffa"));
        }
        for (const client of gameClients) client.send(MessageCodec.encodeReady());
        // A private room's bot plays as its preset account: it is stored and
        // rated as one more participant, but the boards list people only.
        const participants = members.length + (visibility === "private" ? 1 : 0);
        const listed = members.length;
        await vi.waitFor(
          () => {
            expect(
              results.leaderboard({ gametype: "ffa", period: "all", offset: 0, limit: 10, scope: visibility }).total,
            ).toBe(listed);
          },
          { timeout: 30_000, interval: 100 },
        );
        expect(results.leaderboard({ gametype: "ffa", period: "all", offset: 0, limit: 10 }).total).toBe(
          visibility === "private" ? 0 : 2,
        );
        const otherScope = visibility === "private" ? "public" : "private";
        first.send({
          type: "leaderboard:get",
          requestId: "skill-live",
          gametype: "ffa",
          period: "all",
          offset: 0,
          limit: 10,
          scope: visibility,
          system: "trueskill",
        });
        expect(await first.waitFor("leaderboard:page", (message) => message.requestId === "skill-live")).toMatchObject({
          system: "trueskill",
          policyVersion: "shag-trueskill-v1",
          scope: visibility,
          total: listed,
          localProcessing: { excluded: 0 },
          localPlayerEntry: { ratedMatches: 1, provisional: true },
        });
        expect(results.deliveries.has(String(firstConnect.matchId))).toBe(false);
        expect(fs.existsSync(path.join(dir, "result-outbox", `${firstConnect.matchId}.result`))).toBe(false);
        expect(
          results.leaderboard({ gametype: "ffa", period: "all", offset: 0, limit: 10, scope: otherScope }).total,
        ).toBe(0);
        expect(lobby.getResultDiagnostics()).toMatchObject({
          storage: {
            totalMatches: 1,
            totalParticipants: participants,
            latestResult: { scope: visibility, bots: visibility === "private" ? 1 : 0 },
          },
          runtime: { totals: { stored: 1 }, recent: [{ status: "stored", reason: "stored", scope: visibility }] },
        });
        const reopened = MatchResultStore.open(dir);
        try {
          // The real child's gameplay counters survive persistence, and a
          // private bot match rates against the bot's preset account.
          const statsQuery = { gametype: "ffa" as const, scope: visibility, period: "all" as const };
          const summary = reopened.playerStats.summary(members[0].account.id, statsQuery);
          expect(summary).toMatchObject({ matches: 1, draws: 1, statsMatches: 1, totals: { frags: 0 } });
          expect(summary.totals!.activeTimeMs).toBeGreaterThan(0);
          expect(summary.rating).toEqual(expect.objectContaining({ ratedMatches: 1 }));
          const history = reopened.playerStats.history(members[0].account.id, statsQuery);
          expect(history.entries).toHaveLength(1);
          expect(history.entries[0]).toMatchObject({
            matchId: firstConnect.matchId,
            stats: { version: 1, ...summary.totals },
            ratingStatus: "applied",
          });
          expect(history.entries[0].ratingChange).toEqual(expect.objectContaining({ delta: expect.any(Number) }));
          expect(
            reopened.playerStats.summary(members[0].account.id, { ...statsQuery, scope: otherScope }),
          ).toMatchObject({
            matches: 0,
            totals: null,
            rating: null,
          });
          expect(
            reopened.leaderboard({ gametype: "ffa", period: "all", offset: 0, limit: 10, scope: visibility }).total,
          ).toBe(listed);
          expect(MatchResultStore.inspect(dir)).toMatchObject({
            status: "ready",
            statistics: { totalMatches: 1, totalParticipants: participants },
          });
          const journal = reopened.ratings.getResult(firstConnect.matchId as string);
          expect(journal?.receipt).toMatchObject({
            recordStatus: "recorded",
            ratingStatus: "applied",
            ratingReason: "eligible",
          });
          expect(journal?.snapshot.scope).toBe(visibility);
          expect(journal?.snapshot.startingRoster).toHaveLength(2);
          expect(journal?.snapshot.seats).toHaveLength(2);
          expect(journal?.snapshot.seats.every((seat) => seat.participationInterrupted === false)).toBe(true);
          if (visibility === "private") {
            expect(journal?.snapshot.seats.find((seat) => seat.accountId === null)?.botReference).toEqual(
              botReference(),
            );
            expect(journal?.snapshot.startingRoster?.find((seat) => seat.isBot)?.botReference).toEqual(botReference());
            expect(journal?.snapshot.botReferenceChanged).toBe(false);
          }
          expect(reopened.ratings.verifyReplay()).toEqual({
            consistent: true,
            matches: 1,
            updates: 2,
            ratings: 2,
          });
          for (const member of members) {
            expect(reopened.ratings.getRating(member.account.id, "ffa", visibility)?.state.ratedMatches).toBe(1);
            expect(reopened.ratings.getRating(member.account.id, "ffa", otherScope)).toBeNull();
          }
        } finally {
          reopened.close();
        }
        if (visibility === "private") {
          await vi.waitFor(
            () => {
              for (const filename of fs.readdirSync(demoDir)) {
                if (priorDemos.has(filename) || !filename.endsWith(".shagdemo")) continue;
                const file = path.join(demoDir, filename);
                const reader = new DemoReader(new Uint8Array(fs.readFileSync(file)));
                if (reader.readHeader().matchId !== firstConnect.matchId) continue;
                recordedDemo = file;
                expect(reader.readHeader()).toMatchObject({ private: true, version: 6 });
                expect(reader.readAllFrames().length).toBeGreaterThan(0);
              }
              expect(recordedDemo).toBeDefined();
            },
            { timeout: 5000, interval: 100 },
          );
        }
        for (const [index, peer] of peers.slice(0, members.length).entries()) {
          peer.send({
            type: "leaderboard:get",
            requestId: `rank_${index}`,
            gametype: "ffa",
            period: "all",
            offset: 0,
            limit: 10,
            scope: visibility,
          });
          const page = await peer.waitFor("leaderboard:page", (message) => message.requestId === `rank_${index}`);
          expect(page).toMatchObject({ total: listed, localPlayerRank: 1, scope: visibility });
          // Equal records order by account: the people, then the bot's later preset account.
          expect(
            (page.entries as Array<{ playerId: string; draws: number }>)
              .map((entry) => entry.playerId)
              .slice(0, members.length),
          ).toEqual(members.map((member) => String(member.account.id)));
          expect((page.entries as Array<{ draws: number }>).every((entry) => entry.draws === 1)).toBe(true);
        }
        first.send({
          type: "leaderboard:get",
          requestId: "opposite",
          gametype: "ffa",
          period: "all",
          offset: 0,
          limit: 10,
          scope: otherScope,
        });
        const opposite = await first.waitFor("leaderboard:page", (message) => message.requestId === "opposite");
        expect(opposite).toMatchObject({ scope: otherScope, entries: [], total: 0 });
        expect(opposite.localPlayerRank).toBeUndefined();
        // The dedicated server gives human clients a two-minute PostGame grace.
        // Leaving after the verified result exercises the normal empty-server return promptly.
        await Promise.all(gameClients.map((client) => client.close()));
        gameClients.length = 0;
        expect(
          await first.waitFor("match:ended", (message) => message.matchId === firstConnect.matchId, 20_000),
        ).toMatchObject({ matchId: firstConnect.matchId });
      } finally {
        if (priorTime === undefined) delete process.env.SHAG_TIMELIMIT;
        else process.env.SHAG_TIMELIMIT = priorTime;
        if (priorWarmup === undefined) delete process.env.SHAG_WARMUP;
        else process.env.SHAG_WARMUP = priorWarmup;
        await Promise.all(gameClients.map((client) => client.close()));
        await Promise.all(peers.map((peer) => peer.close()));
        await lobby.stop();
        if (recordedDemo) fs.rmSync(recordedDemo, { force: true });
        results.close();
        accounts.close();
        fs.rmSync(target, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
