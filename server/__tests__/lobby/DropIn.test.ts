/** Installed-map integration: a watcher drops into a running lobby match through its spawned server. */
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
import { PlayerStore } from "../../../../../lobby/PlayerStore";
import type { GametypeInfo, MatchLobbyInfo } from "../../../../../lobby/types";
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

/** Resolves once a snapshot carries `entityId`, i.e. the server has spawned that player. */
function spawned(client: ProtocolTestClient, entityId: string, timeout = 8000) {
  return client.waitFor((frame) => {
    if (frame[0] !== MessageType.Snapshot) return false;
    try {
      return MessageCodec.decodeSnapshot(frame).entities.has(entityId);
    } catch {
      return false;
    }
  }, timeout);
}

const hasInstalledWdm2 = fs.existsSync(path.join(process.cwd(), "public", "data", "map_washoi_dm2.pk3"));

describe("dropping into a running lobby match", () => {
  it.skipIf(!hasInstalledWdm2)(
    "seats a watcher on the connection it already has, through the spawned server's stdin",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shag-drop-in-"));
      const target = path.resolve(dir);
      const root = path.resolve(os.tmpdir());
      if (!target.startsWith(`${root}${path.sep}`) || !path.basename(target).startsWith("shag-drop-in-"))
        throw new Error(`Unsafe cleanup target: ${target}`);
      const accounts = PlayerStore.open(dir);
      const members = [accounts.create(), accounts.create(), accounts.create()];
      const spawner = new GameServerSpawner(await unusedPort(), FPS_SERVER_APPLICATION);
      const lobby = new LobbyServer(0, spawner, { players: accounts });
      const peers: LobbyPeer[] = [];
      const gameClients: ProtocolTestClient[] = [];
      const priorTime = process.env.SHAG_TIMELIMIT;
      const priorWarmup = process.env.SHAG_WARMUP;
      try {
        process.env.SHAG_TIMELIMIT = "5m";
        process.env.SHAG_WARMUP = "10s";
        await lobby.start();
        // A three-seat free-for-all that starts with two, leaving one seat free.
        const internal = lobby as unknown as { gametypes: GametypeInfo[]; wss: { address(): { port: number } } };
        const ffa = internal.gametypes.find((mode) => mode.id === "ffa")!;
        ffa.mapPool = ["washoi_dm2"];
        ffa.maxPlayers = 3;
        ffa.minPlayers = 2;
        const lobbyPort = internal.wss.address().port;
        const names: string[] = [];
        for (const member of members) {
          const peer = await LobbyPeer.connect(lobbyPort);
          peers.push(peer);
          peer.send({ type: "auth", key: member.key });
          names.push(((await peer.waitFor("welcome")).identity as { name: string }).name);
        }
        const [first, second, late] = peers;
        first.send({ type: "lobby:create", gametype: "ffa" });
        const room = (await first.waitFor("lobby:created")).lobby as MatchLobbyInfo;
        second.send({ type: "lobby:join", lobbyId: room.id });
        await second.waitFor("lobby:created");
        first.send({ type: "lobby:ready", lobbyId: room.id, ready: true });
        second.send({ type: "lobby:ready", lobbyId: room.id, ready: true });
        const starts = await Promise.all([
          first.waitFor("lobby:connect", () => true, 60_000),
          second.waitFor("lobby:connect", () => true, 60_000),
        ]);
        const serverUrl = String(starts[0].serverUrl);
        const port = Number(new URL(serverUrl).port);
        for (const [index, handoff] of starts.entries()) {
          const client = await ProtocolTestClient.connect(port);
          gameClients.push(client);
          client.send(MessageCodec.encodeJoin(`Seat ${index}`, false, String(handoff.admissionTicket)));
          await client.waitForType(MessageType.JoinAccept);
          client.send(MessageCodec.encodeJoinGame("ffa"));
        }

        // The third account watches without a ticket, then joins the room.
        const watcher = await ProtocolTestClient.connect(port);
        gameClients.push(watcher);
        watcher.send(MessageCodec.encodeJoin("Watcher"));
        const accept = MessageCodec.decodeJoinAccept(await watcher.waitForType(MessageType.JoinAccept));
        late.send({ type: "lobby:join", lobbyId: room.id });
        const seat = await late.waitFor("lobby:connect", () => true, 15_000);
        expect(seat).toMatchObject({ matchId: starts[0].matchId, serverUrl, gametype: "ffa" });
        expect(typeof seat.admissionTicket).toBe("string");
        expect(await late.waitFor("lobby:created")).toMatchObject({ lobby: { id: room.id } });

        watcher.send(MessageCodec.encodeJoinGame(undefined, false, String(seat.admissionTicket)));
        await spawned(watcher, accept.entityId);

        // The players already in the room hear who joined.
        await first.waitFor("lobby:player_joined", (message) => (message.player as { name: string }).name === names[2]);
      } finally {
        if (priorTime === undefined) delete process.env.SHAG_TIMELIMIT;
        else process.env.SHAG_TIMELIMIT = priorTime;
        if (priorWarmup === undefined) delete process.env.SHAG_WARMUP;
        else process.env.SHAG_WARMUP = priorWarmup;
        await Promise.all(gameClients.map((client) => client.close()));
        await Promise.all(peers.map((peer) => peer.close()));
        await lobby.stop();
        accounts.close();
        fs.rmSync(target, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
