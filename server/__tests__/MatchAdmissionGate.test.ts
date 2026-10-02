import { issueDropInSeat, issueMatchAdmission } from "@engine/server/network/MatchAdmission";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageType } from "../../../../engine/network/protocol/BinaryProtocol";
import { MessageCodec } from "../../../../engine/network/protocol/MessageCodec";
import { GameServer, type GameServerConfig } from "../GameServer";
import { Duel } from "../gametypes/Duel";
import { TeamDeathmatch } from "../gametypes/TeamDeathmatch";
import { ProtocolTestClient } from "./_protocolTestClient";

describe("game-server match admission", () => {
  let server: GameServer;
  const clients: ProtocolTestClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    clients.length = 0;
    if (server) await server.stop();
  });

  it("lets unticketed clients watch, retries a dropped pre-game ticket, and binds the playing seat", async () => {
    const { manifest, tickets } = issueMatchAdmission("match-1", [
      { lobbyPlayerId: "p1", accountId: 12, name: "Verified Alice", team: "udon", isBot: false },
    ]);
    const config: GameServerConfig = {
      port: 0,
      serverName: "admission",
      mapName: "test",
      maxClients: 2,
      tickRate: 125,
      snapshotRate: 60,
      certPath: "",
      keyPath: "",
      matchAdmission: manifest,
    };
    server = new GameServer(config, new TeamDeathmatch());
    await server.start();
    const spectator = await ProtocolTestClient.connect(server.getPort());
    clients.push(spectator);
    spectator.send(MessageCodec.encodeJoin("Verified Alice"));
    await spectator.waitForType(MessageType.JoinAccept);
    spectator.send(MessageCodec.encodeJoinGame("udon"));
    await spectator.waitForType(MessageType.ServerMessage);
    expect(server.getGametypeController().getMatchState().totalPlayers).toBe(0);

    let player = await ProtocolTestClient.connect(server.getPort());
    clients.push(player);
    player.send(MessageCodec.encodeJoin("Impostor", false, tickets.get("p1")));
    await player.waitForType(MessageType.JoinAccept);
    await player.close();
    await vi.waitFor(() => {
      const active = (server as unknown as { clients: Map<string, { accountId?: number }> }).clients;
      expect([...active.values()].some((client) => client.accountId === 12)).toBe(false);
    });

    player = await ProtocolTestClient.connect(server.getPort());
    clients.push(player);
    player.send(MessageCodec.encodeJoin("Impostor", false, tickets.get("p1")));
    const accept = MessageCodec.decodeJoinAccept(await player.waitForType(MessageType.JoinAccept));
    player.send(MessageCodec.encodeJoinGame("soba", true));
    await player.waitFor((frame) => {
      if (frame[0] !== MessageType.Snapshot) return false;
      try {
        return MessageCodec.decodeSnapshot(frame).entities.has(accept.entityId);
      } catch {
        return false;
      }
    }, 4000);
    const id = Number(accept.playerId.replace("player_", "")) as never;
    expect(server.getGametypeController().getMatchState().getPlayerTeam(id)).toBe("udon");
    const record = [
      ...(server as unknown as { clients: Map<string, { accountId?: number; playerName: string }> }).clients.values(),
    ].find((client) => client.accountId === 12);
    expect(record?.playerName).toBe("Verified Alice");

    const replay = await ProtocolTestClient.connect(server.getPort());
    clients.push(replay);
    replay.send(MessageCodec.encodeJoin("Verified Alice", false, tickets.get("p1")));
    await expect(replay.waitForType(MessageType.JoinAccept, 100)).rejects.toThrow("timed out");
    expect(server.getGametypeController().getMatchState().totalPlayers).toBe(1);
  });

  it("admits an expired seat through its reserved ticket but cannot claim it twice", async () => {
    const { manifest, tickets, recoveryTickets } = issueMatchAdmission(
      "late-seat",
      [{ lobbyPlayerId: "p1", accountId: 28, name: "Late Alice", team: "udon", isBot: false }],
      Date.now() - 121_000,
      120_000,
      30 * 60_000,
    );
    server = new GameServer(
      {
        port: 0,
        serverName: "late admission",
        mapName: "test",
        maxClients: 2,
        tickRate: 125,
        snapshotRate: 60,
        certPath: "",
        keyPath: "",
        matchAdmission: manifest,
      },
      new TeamDeathmatch(),
    );
    await server.start();
    const expired = await ProtocolTestClient.connect(server.getPort());
    clients.push(expired);
    expired.send(MessageCodec.encodeJoin("Impostor", false, tickets.get("p1")));
    await expect(expired.waitForType(MessageType.JoinAccept, 100)).rejects.toThrow("timed out");

    const recovered = await ProtocolTestClient.connect(server.getPort());
    clients.push(recovered);
    recovered.send(MessageCodec.encodeJoin("Impostor", false, recoveryTickets.get(28)!.ticket));
    const accept = MessageCodec.decodeJoinAccept(await recovered.waitForType(MessageType.JoinAccept));
    recovered.send(MessageCodec.encodeJoinGame("soba", true));
    await recovered.waitFor((frame) => {
      if (frame[0] !== MessageType.Snapshot) return false;
      try {
        return MessageCodec.decodeSnapshot(frame).entities.has(accept.entityId);
      } catch {
        return false;
      }
    }, 4000);
    const active = (server as unknown as { clients: Map<string, { accountId?: number; playerName: string }> }).clients;
    expect([...active.values()].some((client) => client.accountId === 28 && client.playerName === "Late Alice")).toBe(
      true,
    );
    const replay = await ProtocolTestClient.connect(server.getPort());
    clients.push(replay);
    replay.send(MessageCodec.encodeJoin("Late Alice", false, recoveryTickets.get(28)!.ticket));
    await expect(replay.waitForType(MessageType.JoinAccept, 100)).rejects.toThrow("timed out");
    expect(server.getGametypeController().getMatchState().totalPlayers).toBe(1);
  });

  it("seats a spectator who drops in on the connection it already has", async () => {
    const { manifest } = issueMatchAdmission("match-drop", [
      { lobbyPlayerId: "p1", accountId: 12, name: "Alice", team: "udon", isBot: false },
    ]);
    server = new GameServer(
      {
        port: 0,
        serverName: "drop-in",
        mapName: "test",
        maxClients: 4,
        tickRate: 125,
        snapshotRate: 60,
        certPath: "",
        keyPath: "",
        matchAdmission: manifest,
      },
      new TeamDeathmatch(),
    );
    await server.start();
    const watcher = await ProtocolTestClient.connect(server.getPort());
    clients.push(watcher);
    watcher.send(MessageCodec.encodeJoin("Watcher"));
    const accept = MessageCodec.decodeJoinAccept(await watcher.waitForType(MessageType.JoinAccept));

    // The lobby's seat arrives over the server's stdin; the player's ticket
    // over their own connection. A side picked in-game gives way to the seat's.
    const seat = issueDropInSeat({ accountId: 30, name: "Late Bob", team: "soba", isBot: false });
    expect(server.admitSeat(seat.grants)).toBe(true);
    expect(server.admitSeat(issueDropInSeat({ accountId: 30, name: "Again", team: "udon", isBot: false }).grants)).toBe(
      false,
    );
    watcher.send(MessageCodec.encodeJoinGame("udon", true, seat.ticket));
    await watcher.waitFor((frame) => {
      if (frame[0] !== MessageType.Snapshot) return false;
      try {
        return MessageCodec.decodeSnapshot(frame).entities.has(accept.entityId);
      } catch {
        return false;
      }
    }, 4000);
    const id = Number(accept.playerId.replace("player_", "")) as never;
    expect(server.getGametypeController().getMatchState().getPlayerTeam(id)).toBe("soba");
    const active = (server as unknown as { clients: Map<string, { accountId?: number; playerName: string }> }).clients;
    expect([...active.values()].some((client) => client.accountId === 30 && client.playerName === "Late Bob")).toBe(
      true,
    );

    // The ticket is spent: nobody else can sit in that seat.
    const other = await ProtocolTestClient.connect(server.getPort());
    clients.push(other);
    other.send(MessageCodec.encodeJoin("Other"));
    await other.waitForType(MessageType.JoinAccept);
    other.send(MessageCodec.encodeJoinGame(undefined, false, seat.ticket));
    const refusal = MessageCodec.decodeServerMessage(await other.waitForType(MessageType.ServerMessage));
    expect(refusal.message).toBe("That seat is no longer available.");
    expect(server.getGametypeController().getMatchState().totalPlayers).toBe(1);
  });

  it("queues a drop-in to a duel whose sides are taken, and brings them in when one frees", async () => {
    const { manifest, tickets } = issueMatchAdmission("match-duel", [
      { lobbyPlayerId: "p1", accountId: 12, name: "Alice", team: "ffa", isBot: false },
      { lobbyPlayerId: "p2", accountId: 13, name: "Carol", team: "ffa", isBot: false },
    ]);
    server = new GameServer(
      {
        port: 0,
        serverName: "duel-drop-in",
        mapName: "test",
        maxClients: 4,
        tickRate: 125,
        snapshotRate: 60,
        certPath: "",
        keyPath: "",
        matchAdmission: manifest,
      },
      new Duel(),
    );
    await server.start();
    const players: ProtocolTestClient[] = [];
    for (const seat of ["p1", "p2"]) {
      const client = await ProtocolTestClient.connect(server.getPort());
      clients.push(client);
      players.push(client);
      client.send(MessageCodec.encodeJoin(seat, false, tickets.get(seat)));
      const accept = MessageCodec.decodeJoinAccept(await client.waitForType(MessageType.JoinAccept));
      client.send(MessageCodec.encodeJoinGame());
      await client.waitFor((frame) => {
        if (frame[0] !== MessageType.Snapshot) return false;
        try {
          return MessageCodec.decodeSnapshot(frame).entities.has(accept.entityId);
        } catch {
          return false;
        }
      }, 4000);
    }

    const watcher = await ProtocolTestClient.connect(server.getPort());
    clients.push(watcher);
    watcher.send(MessageCodec.encodeJoin("Watcher"));
    const accept = MessageCodec.decodeJoinAccept(await watcher.waitForType(MessageType.JoinAccept));
    const seat = issueDropInSeat({ accountId: 30, name: "Late Bob", team: "ffa", isBot: false });
    expect(server.admitSeat(seat.grants)).toBe(true);
    watcher.send(MessageCodec.encodeJoinGame(undefined, false, seat.ticket));
    const queued = MessageCodec.decodeServerMessage(await watcher.waitForType(MessageType.ServerMessage));
    expect(queued).toEqual({ type: "queue", message: "Both sides are taken. You are #1 in the challengers queue." });

    // Carol drops; her side is held for her, then given up when she does not return.
    await players[1].close();
    await vi.waitFor(() => expect((server as unknown as { suspended: { size: number } }).suspended.size).toBe(1));
    const later = Date.now() + 60_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    (server as unknown as { expireSuspendedSessions(): void }).expireSuspendedSessions();
    vi.restoreAllMocks();
    await watcher.waitFor((frame) => {
      if (frame[0] !== MessageType.Snapshot) return false;
      try {
        return MessageCodec.decodeSnapshot(frame).entities.has(accept.entityId);
      } catch {
        return false;
      }
    }, 4000);
  });
});
