/**
 * What a shooter sees against what the server judges their shot by.
 *
 * The client draws other players from its snapshot buffer, timed with clock
 * sync as the game does. A shot carries the newest snapshot tick, and the server
 * rewinds to that tick less its assumed render delay. If the two disagree, a shot
 * at a moving player is judged against a place they were not drawn. The buffer
 * used to time snapshots by when the server sent them, so it drew a network trip
 * ahead of what had arrived, by extrapolating, and the server judged the shot a
 * network trip earlier than what the shooter saw (B7 stage 3).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClockSync } from "../../../../engine/network/client/ClockSync";
import { SnapshotBuffer } from "../../../../engine/network/client/SnapshotBuffer";
import { SnapshotReceiver } from "../../../../engine/network/client/SnapshotReceiver";
import { MessageType } from "../../../../engine/network/protocol/BinaryProtocol";
import { MessageCodec } from "../../../../engine/network/protocol/MessageCodec";
import { GameServer, type GameServerConfig } from "../GameServer";
import { Deathmatch } from "../gametypes/Deathmatch";
import { ProtocolTestClient } from "./_protocolTestClient";

const TICK_RATE = 125;
const config: GameServerConfig = {
  port: 0,
  serverName: "render-timing",
  mapName: "test",
  maxClients: 8,
  tickRate: TICK_RATE,
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

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out");
    await new Promise((r) => setTimeout(r, 4));
  }
}

/** The server's assumption of how far behind the newest snapshot a client draws (WeaponSystem.interpTicks at 60 Hz). */
const INTERP_TICKS = 2;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Connect a client the way the game does (clock sync, acks, a snapshot buffer
 * fed with server timestamps), then sample what it draws every few ms.
 * A fake entity's `x` is the tick, so a sample says which moment is drawn.
 */
async function drawnAgainstJudged(oneWayMs: number): Promise<{ mismatch: number; ahead: number }> {
  const client = await ProtocolTestClient.connect(server.getPort());
  clients.push(client);
  client.send(MessageCodec.encodeJoin("viewer"));
  await client.waitForType(MessageType.JoinAccept);
  client.send(MessageCodec.encodeJoinGame());
  client.setLatency(oneWayMs);

  const clock = new ClockSync();
  clock.setSendFunction((data) => client.send(data));
  const buffer = new SnapshotBuffer();
  const receiver = new SnapshotReceiver();
  let newest = 0;
  let stop = false;
  void client
    .waitFor((frame) => {
      if (stop || frame.length === 0) return false;
      if (frame[0] === MessageType.Pong) {
        const { clientSendTime, serverTime } = MessageCodec.decodePong(frame);
        clock.processPong(clientSendTime, serverTime);
        return false;
      }
      if (frame[0] !== MessageType.Snapshot) return false;
      try {
        const snapshot = receiver.receive(frame);
        if (!snapshot) return false;
        newest = Math.max(newest, snapshot.tick);
        client.send(MessageCodec.encodeAck(snapshot.tick));
        const serverLocalTime =
          snapshot.serverTimestamp && clock.isSynced() ? clock.toLocalTime(snapshot.serverTimestamp) : undefined;
        const entity = {
          ...{ x: snapshot.tick, y: 0, z: 0, yaw: 0, vx: TICK_RATE, vy: 0, vz: 0 },
          ...{ grounded: true, crouching: false, sliding: false, wallJumping: false },
        };
        buffer.push(snapshot.tick, new Map([["e", entity]]), serverLocalTime);
      } catch {
        // A frame we cannot decode says nothing about timing.
      }
      return false;
    }, 60_000)
    .catch(() => {});
  clock.startSync();

  // The sync burst and the jitter window settle.
  await waitUntil(() => clock.isSynced() && newest > 0, 8000);
  await new Promise((r) => setTimeout(r, 1000));

  const mismatch: number[] = [];
  const ahead: number[] = [];
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 4));
    const drawn = buffer.sample("e")?.x;
    if (drawn === undefined) continue;
    mismatch.push(newest - INTERP_TICKS - drawn);
    ahead.push(drawn - newest);
  }
  stop = true;
  clock.stop();
  return { mismatch: median(mismatch), ahead: median(ahead) };
}

describe("what a shooter sees against what the server judges", () => {
  it("agrees within two ticks at 50 ms each way, and draws only what has arrived", async () => {
    const { mismatch, ahead } = await drawnAgainstJudged(50);
    // Before the fix: about 7 ticks (58 ms) apart, drawn 4 ticks past the newest snapshot.
    expect(Math.abs(mismatch)).toBeLessThanOrEqual(2);
    expect(ahead).toBeLessThanOrEqual(0);
  }, 20_000);
});
