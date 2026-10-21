import type { PlayerId } from "@engine/server/ecs/types";
import { issueDropInSeat, issueMatchAdmission } from "@engine/server/network/MatchAdmission";
import { type MatchResultReport, signMatchResult, verifyMatchResult } from "@engine/server/network/MatchResultReport";
import { MatchPhase } from "@shared/server/gametype";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageType } from "../../../../engine/network/protocol/BinaryProtocol";
import { MessageCodec } from "../../../../engine/network/protocol/MessageCodec";
import { normalizeResult } from "../../../../lobby/ResultSnapshot";
import { matchRatingGroups } from "../../../../shared/ranking/MatchRatingGroups";
import type { ClientInfo } from "../Client";
import { GameServer } from "../GameServer";
import { Amphi } from "../gametypes/Amphi";
import type { BaseGametype } from "../gametypes/BaseGametype";
import { Deathmatch } from "../gametypes/Deathmatch";
import { Duel } from "../gametypes/Duel";
import type { SuspendedSessions } from "../SuspendedSessions";
import { ProtocolTestClient } from "./_protocolTestClient";

class FastFfa extends Deathmatch {
  override getMatchConfig() {
    return { ...super.getMatchConfig(), countdownDuration: 0.03, timeLimit: 0.8, scoreLimit: 0 };
  }
}
class FastDuel extends Duel {
  override getMatchConfig() {
    return { ...super.getMatchConfig(), countdownDuration: 0.03 };
  }
}
class FastAmphi extends Amphi {
  override getMatchConfig() {
    return { ...super.getMatchConfig(), countdownDuration: 0.03 };
  }
}

describe("played match result over real sockets", () => {
  let server: GameServer;
  const clients: ProtocolTestClient[] = [];
  let reports: MatchResultReport[];

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    clients.length = 0;
    if (server) await server.stop();
  });

  async function setup(gametype: "ffa" | "duel" | "amphi" = "ffa", count = 3, lobbyAliases = false) {
    const startedAt = Date.now();
    const { manifest, tickets } = issueMatchAdmission(
      "played-result",
      Array.from({ length: count }, (_, i) => ({
        lobbyPlayerId: String(i),
        accountId: 10 + i,
        name: `Player ${i}`,
        team: gametype === "ffa" ? "ffa" : lobbyAliases ? (i === 0 ? "alpha" : "bravo") : i === 0 ? "udon" : "soba",
        isBot: false,
      })),
      startedAt,
    );
    reports = [];
    const mode: BaseGametype =
      gametype === "ffa" ? new FastFfa() : gametype === "duel" ? new FastDuel() : new FastAmphi();
    server = new GameServer(
      {
        port: 0,
        serverName: "result-test",
        mapName: "test",
        maxClients: count,
        tickRate: 125,
        snapshotRate: 60,
        certPath: "",
        keyPath: "",
        singleMatch: true,
        matchAdmission: manifest,
        matchGametype: gametype,
        onFinalResult: (report) => reports.push(report),
      },
      mode,
    );
    await server.start();
    const ids: PlayerId[] = [];
    const tokens: string[] = [];
    for (let i = 0; i < count; i++) {
      const client = await ProtocolTestClient.connect(server.getPort());
      clients.push(client);
      client.send(MessageCodec.encodeJoin(`Player ${i}`, false, tickets.get(String(i))));
      const accept = MessageCodec.decodeJoinAccept(await client.waitForType(MessageType.JoinAccept));
      tokens.push(MessageCodec.decodeResumeToken(await client.waitForType(MessageType.ResumeToken)).token);
      ids.push(Number(accept.playerId.replace("player_", "")) as PlayerId);
      if (gametype === "amphi") client.send(MessageCodec.encodeSetLoadout("rlauncher", "machinegun"));
      client.send(MessageCodec.encodeJoinGame());
    }
    const match = server.getGametypeController().getMatchState();
    await vi.waitFor(() => expect(match.totalPlayers).toBe(count));
    for (const client of clients) client.send(MessageCodec.encodeReady());
    await vi.waitFor(() => expect(match.phase).toBe(MatchPhase.Active));
    const expected = { matchId: manifest.matchId, map: "test", gametype, startedAt, admission: manifest };
    return { match, ids, tokens, expected };
  }

  function sessions() {
    return (server as unknown as { suspended: SuspendedSessions<ClientInfo> }).suspended;
  }

  async function expire(ids: readonly PlayerId[]) {
    await vi.waitFor(() =>
      expect(
        sessions()
          .clients()
          .filter((client) => ids.includes(client.playerId)),
      ).toHaveLength(ids.length),
    );
    // Advance the held records' clock, not the production grace or socket timers.
    for (const client of sessions().clients())
      if (ids.includes(client.playerId)) sessions().suspend(client, Date.now() - 20_001);
  }

  async function final(expected: Parameters<typeof verifyMatchResult>[2]) {
    await vi.waitFor(() => expect(reports).toHaveLength(1));
    const report = reports[0];
    expect(verifyMatchResult(signMatchResult(report, "secret"), "secret", expected)).toEqual(report);
    return report;
  }

  it("includes a held disconnected player at a normal finish and ranks lower ties", async () => {
    const { match, ids, expected } = await setup("ffa", 4);
    match.addScore(ids[0], 5);
    match.addScore(ids[1], 3);
    match.addScore(ids[2], 3);
    match.addScore(ids[3], -1);
    await clients[0].close();
    const report = await final(expected);
    expect(report.participants.map((player) => [player.accountId, player.score, player.outcome])).toEqual([
      [10, 5, "win"],
      [11, 3, "loss"],
      [12, 3, "loss"],
      [13, -1, "loss"],
    ]);
    expect(report.details?.seats.map((seat) => seat.placement)).toEqual([1, 2, 2, 4]);
    expect(report.details?.seats[0]).toMatchObject({
      disconnected: true,
      leftAtTick: null,
      participationInterrupted: false,
    });
  });

  it("keeps an expired FFA leader's score without changing the active roster", async () => {
    const { match, ids, expected } = await setup();
    match.addScore(ids[0], 8);
    match.recordStat(ids[0], (stats) => {
      stats.frags = 9;
      stats.deaths = 2;
      stats.damageGiven = 1234.5;
    });
    match.addScore(ids[1], 2);
    await clients[0].close();
    await expire([ids[0]]);
    await vi.waitFor(() => expect(match.totalPlayers).toBe(2));
    expect(match.scores.has(ids[0])).toBe(false);
    const report = await final(expected);
    expect(report.participants[0]).toMatchObject({ accountId: 10, score: 8, outcome: "win" });
    expect(report.details?.seats[0]).toMatchObject({
      stats: { version: 1, score: 8, frags: 9, deaths: 2, damageGiven: 1234.5 },
      placement: 1,
      disconnected: true,
      leftAtTick: expect.any(Number),
      participationInterrupted: true,
    });
    expect(match.winner).toMatchObject({ kind: "player", id: String(ids[0]) });
  });

  it("resumes into the same result seat exactly once", async () => {
    const { match, ids, tokens, expected } = await setup();
    match.addScore(ids[0], 4);
    await clients[0].close();
    await vi.waitFor(() => expect(sessions().size).toBe(1));
    const returning = await ProtocolTestClient.connect(server.getPort());
    clients.push(returning);
    returning.send(MessageCodec.encodeResume(tokens[0]));
    await returning.waitForType(MessageType.JoinAccept);
    const report = await final(expected);
    expect(report.participants).toHaveLength(3);
    expect(report.participants.filter((player) => player.accountId === 10)).toEqual([
      { tokenHash: expected.admission.grants[0].tokenHash, accountId: 10, score: 4, outcome: "win" },
    ]);
    expect(report.details?.seats[0]).toMatchObject({
      seatId: expected.admission.grants[0].seatId,
      disconnected: false,
      lateJoin: false,
      participationInterrupted: false,
    });
  });

  it("captures a late drop-in, excludes a watcher, and preserves tied FFA winners", async () => {
    const { match, ids, expected } = await setup();
    match.addScore(ids[0], 5);
    match.addScore(ids[1], 5);
    await clients[2].close();
    await expire([ids[2]]);
    await vi.waitFor(() => expect(match.totalPlayers).toBe(2));
    const dropIn = issueDropInSeat({ accountId: 30, name: "Late player", team: "ffa", isBot: false });
    expect(server.admitSeat(dropIn.grants)).toBe(true);
    const late = await ProtocolTestClient.connect(server.getPort());
    clients.push(late);
    late.send(MessageCodec.encodeJoin("Late player", false, dropIn.ticket));
    await late.waitForType(MessageType.JoinAccept);
    late.send(MessageCodec.encodeJoinGame());
    const watcher = await ProtocolTestClient.connect(server.getPort());
    clients.push(watcher);
    watcher.send(MessageCodec.encodeJoin("Watcher"));
    await watcher.waitForType(MessageType.JoinAccept);
    await vi.waitFor(() => expect(match.totalPlayers).toBe(3));
    const report = await final(expected);
    expect(report.participants.map((player) => player.outcome)).toEqual(["draw", "draw", "loss", "loss"]);
    expect(report.details.seats.map((seat) => seat.placement)).toEqual([1, 1, 3, 3]);
    expect(report.details.seats[3]).toMatchObject({
      seatId: dropIn.grants[0].seatId,
      lateJoin: true,
      teamsPlayed: ["ffa"],
    });
    expect(report.participants.map((player) => player.accountId)).toEqual([10, 11, 12, 30]);
  });

  it("latches spectator interruption even after rejoining the same FFA seat", async () => {
    const { match, ids, expected } = await setup();
    const active = () =>
      [...(server as unknown as { clients: Map<string, ClientInfo> }).clients.values()].find(
        (client) => client.playerId === ids[0],
      )!;
    active().lastTeamSwitchMs = undefined; // Keep production's 3-second request limit unchanged.
    clients[0].send(MessageCodec.encodeSpectate());
    await vi.waitFor(() => expect(match.totalPlayers).toBe(2));
    active().lastTeamSwitchMs = undefined;
    clients[0].send(MessageCodec.encodeJoinGame());
    await vi.waitFor(() => expect(match.totalPlayers).toBe(3));
    const report = await final(expected);
    const seat = report.details.seats.find((seat) => seat.seatId === expected.admission.grants[0].seatId);
    expect(seat).toMatchObject({
      participationInterrupted: true,
      leftAtTick: null,
      lateJoin: false,
      teamsPlayed: ["ffa"],
    });
  });

  it.each(["duel", "amphi"] as const)("rates a real %s forfeit from lobby display sides", async (mode) => {
    const { match, ids, expected } = await setup(mode, 2, true);
    expect(match.getPlayerTeam(ids[0])).toBe("soba");
    expect(match.getPlayerTeam(ids[1])).toBe("udon");
    await clients[0].close();
    await expire([ids[0]]);
    const report = await final(expected);
    const snapshot = normalizeResult(report, {
      private: false,
      ranked: true,
      bots: 0,
      startingRoster: [
        { accountId: 10, isBot: false, team: "alpha" },
        { accountId: 11, isBot: false, team: "bravo" },
      ],
    });
    expect(snapshot.completion).toBe("forfeit");
    expect(matchRatingGroups(snapshot)).toMatchObject({ status: "applied" });
  });

  it.each(["duel", "amphi"] as const)(
    "declares a %s forfeit only after grace, preserving scores and both seats",
    async (mode) => {
      const { match, ids, expected } = await setup(mode, 2);
      match.addTeamScore("udon", 5);
      await clients[0].close();
      await vi.waitFor(() => expect(sessions().size).toBe(1));
      expect(match.phase).toBe(MatchPhase.Active);
      expect(reports).toHaveLength(0);
      await expire([ids[0]]);
      const report = await final(expected);
      expect(report.details?.completion).toBe("forfeit");
      expect(report.participants).toMatchObject([
        { accountId: 10, score: 5, outcome: "loss" },
        { accountId: 11, score: 0, outcome: "win" },
      ]);
      expect(report.details?.seats).toMatchObject([
        { forfeited: true, disconnected: true, placement: 2, participationInterrupted: false },
        { forfeited: false, disconnected: false, placement: 1, participationInterrupted: false },
      ]);
      expect(match.winner).toMatchObject({ kind: "team", id: "soba" });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(reports).toHaveLength(1);
    },
  );

  it("marks simultaneous Duel departures as aborted, with no winner or forfeit", async () => {
    const { ids, expected } = await setup("duel", 2);
    await Promise.all(clients.map((client) => client.close()));
    await expire(ids);
    const report = await final(expected);
    expect(report.details?.completion).toBe("aborted");
    expect(report.participants.every((player) => player.outcome === null)).toBe(true);
    expect(report.details?.seats.every((seat) => seat.placement === null && !seat.forfeited)).toBe(true);
  });

  it("reports a graceful mid-match stop as aborted once", async () => {
    const { expected } = await setup();
    await server.stop();
    const report = await final(expected);
    expect(report.details?.completion).toBe("aborted");
    expect(report.participants.every((player) => player.outcome === null)).toBe(true);
    await server.stop();
    expect(reports).toHaveLength(1);
  });
});
