/**
 * GameServer protocol smoke suite (QA-WO1).
 *
 * Sends real bytes through a real GameServer over an ephemeral WebSocket port
 * and asserts on decoded responses — exercising the `handleDatagram` routing
 * layer that every mocked-transport unit test skips. This is the exact gap that
 * shipped the broken-chat bug: the codec round-trips were all green, but nothing
 * verified that a Chat frame routed end-to-end. The `chat → echo` case here is a
 * standing regression guard for it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageType } from "../../../../engine/network/protocol/BinaryProtocol";
import { MessageCodec } from "../../../../engine/network/protocol/MessageCodec";
import { Deathmatch } from "../gametypes/Deathmatch";
import { GameServer, type GameServerConfig } from "../GameServer";
import { ProtocolTestClient } from "./_protocolTestClient";

const config: GameServerConfig = {
  port: 0, // ephemeral — real bind, resolved via server.getPort()
  serverName: "smoke",
  mapName: "test",
  maxClients: 8,
  tickRate: 125,
  snapshotRate: 60,
  certPath: "",
  keyPath: "",
};

let server: GameServer;
let clients: ProtocolTestClient[] = [];

beforeEach(async () => {
  server = new GameServer(config, new Deathmatch());
  await server.start();
});

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
  await server.stop();
});

async function connect(): Promise<ProtocolTestClient> {
  const client = await ProtocolTestClient.connect(server.getPort());
  clients.push(client);
  return client;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Find a chat event carrying `text` in a decoded snapshot frame, or null. */
function chatInSnapshot(frame: Uint8Array, text: string): { senderName: string } | null {
  if (frame[0] !== MessageType.Snapshot) return null;
  try {
    const state = MessageCodec.decodeSnapshot(frame);
    const chat = state.events.find(
      (e) => e.type === "chat" && (e as { text?: string }).text === text,
    ) as { senderName: string } | undefined;
    return chat ?? null;
  } catch {
    return null;
  }
}

describe("GameServer protocol smoke (real socket)", () => {
  it("replies to Join with Welcome + JoinAccept", async () => {
    const client = await connect();
    client.send(MessageCodec.encodeJoin("smoke-tester"));

    const welcome = MessageCodec.decodeWelcome(await client.waitForType(MessageType.Welcome));
    expect(welcome.map).toBe("test");

    const accept = MessageCodec.decodeJoinAccept(await client.waitForType(MessageType.JoinAccept));
    expect(accept.playerId).toMatch(/^player_/);
    expect(accept.entityId).toMatch(/^player_/);
  });

  it("answers Ping with a Pong echoing the client send time", async () => {
    const client = await connect();
    // Ping is only routed for a registered client, so Join first.
    client.send(MessageCodec.encodeJoin("pinger"));
    await client.waitForType(MessageType.JoinAccept);

    const sendTime = 1234567.5;
    client.send(MessageCodec.encodePing(sendTime));
    const pong = MessageCodec.decodePong(await client.waitForType(MessageType.Pong));
    expect(pong.clientSendTime).toBe(sendTime);
    expect(pong.serverTime).toBeGreaterThan(0);
  });

  // The regression guard for the shipped chat bug: a Chat frame must route
  // through handleDatagram and come back as a chat event in a snapshot.
  it("routes Chat over the datagram channel and echoes it in a snapshot", async () => {
    const client = await connect();
    client.send(MessageCodec.encodeJoin("chatter"));
    await client.waitForType(MessageType.JoinAccept);

    client.send(MessageCodec.encodeChat("hello smoke"));

    const frame = await client.waitFor((f) => chatInSnapshot(f, "hello smoke") !== null, 4000);
    const chat = chatInSnapshot(frame, "hello smoke");
    expect(chat).not.toBeNull();
    expect(chat?.senderName).toBe("chatter");
  });

  it("spawns a player entity after JoinGame, visible in later snapshots", async () => {
    const client = await connect();
    client.send(MessageCodec.encodeJoin("player1"));
    const accept = MessageCodec.decodeJoinAccept(await client.waitForType(MessageType.JoinAccept));
    const myEntityKey = accept.entityId; // "player_<n>", matches snapshot entity key

    client.send(MessageCodec.encodeJoinGame());

    const frame = await client.waitFor((f) => {
      if (f[0] !== MessageType.Snapshot) return false;
      try {
        return MessageCodec.decodeSnapshot(f).entities.has(myEntityKey);
      } catch {
        return false;
      }
    }, 4000);
    expect(frame).toBeTruthy();
  });

  it("removes the client from the server when the socket closes", async () => {
    const client = await connect();
    client.send(MessageCodec.encodeJoin("leaver"));
    await client.waitForType(MessageType.JoinAccept);
    await waitUntil(() => server.getClientCount() === 1);

    await client.close();
    await waitUntil(() => server.getClientCount() === 0);
    expect(server.getClientCount()).toBe(0);
  });
});
