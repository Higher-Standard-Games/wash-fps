/**
 * A dropped player's seat is held, and only their own resume token takes it back.
 *
 * Driven over a real socket against a real server, because what broke in play was
 * a connection that died without either side noticing — the routing and the
 * per-connection state are the point, not the game logic above them.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageType } from "../../../../engine/network/protocol/BinaryProtocol";
import { MessageCodec } from "../../../../engine/network/protocol/MessageCodec";
import { GameServer, type GameServerConfig } from "../GameServer";
import { Deathmatch } from "../gametypes/Deathmatch";
import { ProtocolTestClient } from "./_protocolTestClient";

const config = (maxClients = 8): GameServerConfig => ({
  port: 0,
  serverName: "resume",
  mapName: "test",
  maxClients,
  tickRate: 125,
  snapshotRate: 60,
  certPath: "",
  keyPath: "",
});

interface Session {
  token: string;
  playerId: string;
  entityId: string;
}

let server: GameServer;
let clients: ProtocolTestClient[] = [];

async function connect(): Promise<ProtocolTestClient> {
  const client = await ProtocolTestClient.connect(server.getPort());
  clients.push(client);
  return client;
}

/** Join as `name` and return the seat the server handed out. */
async function join(client: ProtocolTestClient, name: string): Promise<Session> {
  client.send(MessageCodec.encodeJoin(name));
  const accept = MessageCodec.decodeJoinAccept(await client.waitForType(MessageType.JoinAccept));
  const { token } = MessageCodec.decodeResumeToken(await client.waitForType(MessageType.ResumeToken));
  return { token, playerId: accept.playerId, entityId: accept.entityId };
}

/** Join and take a seat in the match itself. */
async function playing(client: ProtocolTestClient, name = "dropper"): Promise<Session> {
  const session = await join(client, name);
  client.send(MessageCodec.encodeJoinGame());
  await client.waitFor((data) => data[0] === MessageType.Snapshot && hasEntity(data, session.entityId), 4000);
  return session;
}

function hasEntity(frame: Uint8Array, entityId: string): boolean {
  try {
    return MessageCodec.decodeSnapshot(frame).entities.has(entityId);
  } catch {
    return false;
  }
}

/** The server's own record for a player, to check what a resume reset. */
function record(playerId: string): { lastAckedTick: number; snapshotsSinceFull?: number; lastInputSeq: number } {
  const clients = (server as unknown as { clients: Map<string, Record<string, unknown>> }).clients;
  const found = [...clients.values()].find((client) => String(client.playerId) === playerId.replace(/^player_/, ""));
  if (!found) throw new Error(`no server record for ${playerId}`);
  return found as unknown as { lastAckedTick: number; snapshotsSinceFull?: number; lastInputSeq: number };
}

async function start(maxClients?: number): Promise<void> {
  server = new GameServer(config(maxClients), new Deathmatch());
  await server.start();
}

beforeEach(() => {
  clients = [];
});

afterEach(async () => {
  for (const client of clients) await client.close();
  clients = [];
  await server.stop();
});

describe("session resume", () => {
  it("gives a dropped player the same entity back, still in the match", async () => {
    await start();
    const client = await connect();
    const session = await playing(client);
    expect(server.getGametypeController().getMatchState().totalPlayers).toBe(1);

    await client.close();
    const returning = await connect();
    returning.send(MessageCodec.encodeResume(session.token));
    const accept = MessageCodec.decodeJoinAccept(await returning.waitForType(MessageType.JoinAccept));

    expect(accept.playerId).toBe(session.playerId);
    expect(accept.entityId).toBe(session.entityId);
    expect(server.getGametypeController().getMatchState().totalPlayers).toBe(1);
    await returning.waitFor((data) => data[0] === MessageType.Snapshot && hasEntity(data, session.entityId), 4000);
  });

  it("starts the new connection from scratch: no baseline, no input history", async () => {
    await start();
    const client = await connect();
    const session = await playing(client);
    // Acknowledge a snapshot and send a command, so the old connection has state.
    const snapshot = await client.waitFor((data) => data[0] === MessageType.Snapshot, 4000);
    client.send(MessageCodec.encodeAck(MessageCodec.readSnapshotHeader(snapshot).tick));
    client.send(MessageCodec.encodeCommand(session.playerId, 5000, { direction: { x: 0, y: 0, z: 1 } }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(record(session.playerId).lastInputSeq).toBe(5000);

    await client.close();
    const returning = await connect();
    returning.send(MessageCodec.encodeResume(session.token));
    await returning.waitForType(MessageType.JoinAccept);

    const resumed = record(session.playerId);
    expect(resumed.lastAckedTick).toBe(0);
    expect(resumed.snapshotsSinceFull).toBe(0);
    // A reconnected client counts its commands from one again; a kept high-water
    // mark would drop every one of them as already seen.
    expect(resumed.lastInputSeq).toBe(0);
    const frame = await returning.waitFor((data) => data[0] === MessageType.Snapshot, 4000);
    expect(MessageCodec.readSnapshotHeader(frame).baselineTick).toBeNull();
  });

  it("refuses another player's token, and each client gets its own", async () => {
    await start();
    const mine = await connect();
    const theirs = await connect();
    const session = await playing(mine, "dropper");
    const other = await join(theirs, "bystander");

    expect(other.token).not.toBe(session.token);

    await mine.close();
    const returning = await connect();
    returning.send(MessageCodec.encodeResume(other.token));
    const message = MessageCodec.decodeServerMessage(await returning.waitForType(MessageType.ServerMessage));

    expect(message.message).toContain("expired");
    expect(returning.frames.some((frame) => frame[0] === MessageType.JoinAccept)).toBe(false);

    // The dropped player's own token still works.
    returning.send(MessageCodec.encodeResume(session.token));
    const accept = MessageCodec.decodeJoinAccept(await returning.waitForType(MessageType.JoinAccept));
    expect(accept.entityId).toBe(session.entityId);
  });

  it("does not hand a held seat to a queued challenger", async () => {
    await start(1);
    const player = await connect();
    const session = await playing(player, "dropper");
    const challenger = await connect();
    await join(challenger, "challenger");
    challenger.send(MessageCodec.encodeJoinGame());
    await challenger.waitForType(MessageType.ServerMessage, 4000);

    await player.close();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The seat is still the dropped player's: the challenger stays a spectator.
    expect(server.getGametypeController().getMatchState().totalPlayers).toBe(1);
    const returning = await connect();
    returning.send(MessageCodec.encodeResume(session.token));
    const accept = MessageCodec.decodeJoinAccept(await returning.waitForType(MessageType.JoinAccept));
    expect(accept.entityId).toBe(session.entityId);
  });
});
