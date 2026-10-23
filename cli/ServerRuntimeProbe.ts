/** Real lobby -> room -> runtime-inherited child -> match -> SQLite result. */
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { MessageCodec, MessageType } from "../../../engine/network/protocol/MessageCodec";
import { GameServerSpawner } from "../../../lobby/GameServerSpawner";
import { LobbyServer } from "../../../lobby/LobbyServer";
import { MatchResultStore } from "../../../lobby/MatchResultStore";
import { PlayerStore } from "../../../lobby/PlayerStore";
import type { GametypeInfo, MatchLobbyInfo } from "../../../lobby/types";
import { ProtocolTestClient } from "../server/__tests__/_protocolTestClient";
import { FPS_SERVER_APPLICATION } from "../server/FpsServerApplication";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => T | undefined | false, timeout = 45000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = read();
    if (value) return value;
    await sleep(25);
  }
  throw new Error("Runtime probe timed out");
}
async function unusedPort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as net.AddressInfo).port;
  server.close();
  await once(server, "close");
  return port;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shag-runtime-probe-"));
  const players = PlayerStore.open(dir),
    results = MatchResultStore.open(dir);
  const spawner = new GameServerSpawner(await unusedPort(), FPS_SERVER_APPLICATION);
  const lobby = new LobbyServer(0, spawner, { players, results });
  const sockets: WebSocket[] = [],
    clients: ProtocolTestClient[] = [];
  const runtimeRecords: { runtime: string; executable: string }[] = [];
  const originalSpawn = spawner.spawn.bind(spawner);
  spawner.spawn = async (config) => {
    const spawned = await originalSpawn(config);
    // Runtime identity precedes the ready marker; child stdout is already
    // consumed by the spawner. Its actual executable is also recorded here.
    runtimeRecords.push({ runtime: process.versions.bun ? "bun" : "node", executable: spawned.process.spawnfile });
    assert.equal(spawned.process.spawnfile, process.execPath);
    assert.equal(spawned.process.spawnargs[1], path.resolve("dist-server/headless-netserver-v2.mjs"));
    return spawned;
  };
  const mapConfig = path.join(dir, "maps.json");
  fs.writeFileSync(mapConfig, JSON.stringify({ washoi_dm2: { displayName: "Probe", gametypes: ["ffa"] } }));
  (lobby as unknown as { MAP_CONFIG_PATH: string }).MAP_CONFIG_PATH = mapConfig;
  process.env.SHAG_TIMELIMIT = "2s";
  process.env.SHAG_WARMUP = "10s";
  try {
    await lobby.start();
    const internal = lobby as unknown as { wss: { address(): net.AddressInfo }; gametypes: GametypeInfo[] };
    assert.deepEqual(internal.gametypes.find((g) => g.id === "ffa")?.mapPool, ["washoi_dm2"]);
    const peers = [];
    for (let i = 0; i < 4; i++) {
      const account = players.create();
      const socket = new WebSocket(`ws://127.0.0.1:${internal.wss.address().port}`);
      sockets.push(socket);
      const messages: Record<string, unknown>[] = [];
      socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
      await once(socket, "open");
      const send = (message: Record<string, unknown>) => socket.send(JSON.stringify(message));
      const wait = (type: string) => until(() => messages.find((m) => m.type === type));
      send({ type: "auth", key: account.key });
      await wait("welcome");
      peers.push({ send, wait });
    }
    peers[0].send({ type: "lobby:create", gametype: "ffa", visibility: "public" });
    const room = (await peers[0].wait("lobby:created")).lobby as MatchLobbyInfo;
    for (const peer of peers.slice(1)) {
      peer.send({ type: "lobby:join", lobbyId: room.id });
      await peer.wait("lobby:created");
    }
    for (const peer of peers) peer.send({ type: "lobby:ready", lobbyId: room.id, ready: true });
    const handoffs = await Promise.all(peers.map((peer) => peer.wait("lobby:connect")));
    for (const [index, handoff] of handoffs.entries()) {
      const client = await ProtocolTestClient.connect(Number(new URL(String(handoff.serverUrl)).port));
      clients.push(client);
      client.send(MessageCodec.encodeJoin(`RuntimeProbe${index}`, false, String(handoff.admissionTicket)));
      await client.waitForType(MessageType.JoinAccept);
      client.send(MessageCodec.encodeJoinGame("ffa"));
    }
    for (const client of clients) client.send(MessageCodec.encodeReady());
    await until(() => results.leaderboard({ gametype: "ffa", period: "all", offset: 0, limit: 10 }).total === 4, 35000);
    assert.equal(results.deliveries.has(String(handoffs[0].matchId)), false);
    assert.equal(runtimeRecords.length, 1);
    console.log(
      `[RuntimeProbe] ${JSON.stringify({
        runtime: process.versions.bun ? "bun" : "node",
        version: process.versions.bun ?? process.versions.node,
        child: runtimeRecords[0],
        accounts: 4,
        resultRows: 4,
        directory: dir,
        passed: true,
      })}`,
    );
  } finally {
    for (const client of clients) await client.close();
    for (const socket of sockets) socket.terminate();
    await lobby.stop();
    results.close();
    players.close();
    // Scratch output is retained for inspection; no real accounts are touched.
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
