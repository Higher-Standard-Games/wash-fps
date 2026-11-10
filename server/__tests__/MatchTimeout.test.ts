/**
 * Timeouts over real sockets: the server's loop stands still, chat goes on,
 * time in counts back in, and a player dropping out of a duel pauses it.
 */
import { issueMatchAdmission } from "@engine/server/network/MatchAdmission";
import { MatchPhase } from "@shared/server/gametype";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageType } from "../../../../engine/network/protocol/BinaryProtocol";
import { MessageCodec } from "../../../../engine/network/protocol/MessageCodec";
import type { ClientInfo } from "../Client";
import { GameServer } from "../GameServer";
import type { BaseGametype } from "../gametypes/BaseGametype";
import { Deathmatch } from "../gametypes/Deathmatch";
import { Duel } from "../gametypes/Duel";
import type { MatchPause } from "../MatchPause";
import type { SuspendedSessions } from "../SuspendedSessions";
import { ProtocolTestClient } from "./_protocolTestClient";

class FastDuel extends Duel {
  override getMatchConfig() {
    return { ...super.getMatchConfig(), countdownDuration: 0.03 };
  }
}
class FastFfa extends Deathmatch {
  override getMatchConfig() {
    return { ...super.getMatchConfig(), countdownDuration: 0.03 };
  }
}

describe("timeouts over real sockets", () => {
  let server: GameServer;
  const clients: ProtocolTestClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    clients.length = 0;
    if (server) await server.stop();
  });

  async function setup(mode: BaseGametype, gametype: "duel" | "ffa") {
    const { manifest, tickets } = issueMatchAdmission(
      "timeout-test",
      [0, 1].map((i) => ({
        lobbyPlayerId: String(i),
        accountId: 10 + i,
        name: `Player ${i}`,
        team: gametype === "ffa" ? "ffa" : i === 0 ? "udon" : "soba",
        isBot: false,
      })),
    );
    server = new GameServer(
      {
        port: 0,
        serverName: "timeout-test",
        mapName: "test",
        maxClients: 2,
        tickRate: 125,
        snapshotRate: 60,
        certPath: "",
        keyPath: "",
        singleMatch: true,
        matchAdmission: manifest,
        matchGametype: gametype,
        onFinalResult: () => {},
      },
      mode,
    );
    await server.start();
    const tokens: string[] = [];
    for (let i = 0; i < 2; i++) {
      const client = await ProtocolTestClient.connect(server.getPort());
      clients.push(client);
      client.send(MessageCodec.encodeJoin(`Player ${i}`, false, tickets.get(String(i))));
      await client.waitForType(MessageType.JoinAccept);
      tokens.push(MessageCodec.decodeResumeToken(await client.waitForType(MessageType.ResumeToken)).token);
      client.send(MessageCodec.encodeJoinGame());
    }
    const match = server.getGametypeController().getMatchState();
    await vi.waitFor(() => expect(match.totalPlayers).toBe(2));
    for (const client of clients) client.send(MessageCodec.encodeReady());
    await vi.waitFor(() => expect(match.phase).toBe(MatchPhase.Active));
    return { match, tokens };
  }

  const tick = () => server.getStats().tick;
  const pauseOf = () => (server as unknown as { pause: MatchPause }).pause;
  const held = () => (server as unknown as { suspended: SuspendedSessions<ClientInfo> }).suspended;

  /** The first Pause message in `state` a client received, or the next one. */
  async function nextPause(client: ProtocolTestClient, state: string, timeoutMs = 3000) {
    const frame = await client.waitFor(
      (f) => f[0] === MessageType.Pause && MessageCodec.decodePause(f).state === state,
      timeoutMs,
    );
    return MessageCodec.decodePause(frame);
  }

  it("holds the match still, keeps chat, and counts back in on time in", async () => {
    await setup(new FastDuel(), "duel");
    clients[0].send(MessageCodec.encodeCallPause(true));
    for (const client of clients) {
      expect(await nextPause(client, "timeout")).toMatchObject({ caller: "Player 0", forDrop: false });
    }
    const frozen = tick();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(tick()).toBe(frozen);

    clients[1].send(MessageCodec.encodeChat("still here"));
    const chat = MessageCodec.decodePausedChat(await clients[0].waitFor((f) => f[0] === MessageType.PausedChat));
    expect(chat).toMatchObject({ senderName: "Player 1", text: "still here" });

    clients[1].send(MessageCodec.encodeCallPause(false));
    expect((await nextPause(clients[0], "timein")).msLeft).toBeGreaterThan(2500);
    expect(tick()).toBe(frozen);
    await nextPause(clients[0], "running", 4500);
    await vi.waitFor(() => expect(tick()).toBeGreaterThan(frozen));

    // One timeout each a match
    clients[0].send(MessageCodec.encodeCallPause(true));
    const refusal = await clients[0].waitFor(
      (f) => f[0] === MessageType.ServerMessage && MessageCodec.decodeServerMessage(f).message.includes("already used"),
    );
    expect(refusal).toBeDefined();
    expect(pauseOf().paused).toBe(false);
  }, 15_000);

  it("pauses a duel when a player drops, and holds their seat through it", async () => {
    const { tokens } = await setup(new FastDuel(), "duel");
    await clients[1].close();
    expect(await nextPause(clients[0], "timeout")).toMatchObject({ caller: "Player 1", forDrop: true });
    await vi.waitFor(() => expect(held().size).toBe(1));
    // The seat's time stands still with the match
    const holdClock = () => (server as unknown as { holdClock(): number }).holdClock();
    const before = holdClock();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(holdClock() - before).toBeLessThan(50);

    const back = await ProtocolTestClient.connect(server.getPort());
    clients.push(back);
    back.send(MessageCodec.encodeResume(tokens[1]));
    await back.waitForType(MessageType.JoinAccept);
    expect((await nextPause(back, "timeout")).caller).toBe("Player 1");
  });

  it("gives up a dropped player's seat when their timeout runs out", async () => {
    const { match } = await setup(new FastDuel(), "duel");
    await clients[1].close();
    await nextPause(clients[0], "timeout");
    const pause = pauseOf() as unknown as { endsAt: number };
    pause.endsAt = Date.now();
    await nextPause(clients[0], "timein");
    pause.endsAt = Date.now();
    await nextPause(clients[0], "running");
    await vi.waitFor(() => expect(match.phase).toBe(MatchPhase.PostGame));
    expect(match.completion).toBe("forfeit");
  });

  it("has no timeouts in free-for-all", async () => {
    await setup(new FastFfa(), "ffa");
    clients[0].send(MessageCodec.encodeCallPause(true));
    const frame = await clients[0].waitFor(
      (f) => f[0] === MessageType.ServerMessage && MessageCodec.decodeServerMessage(f).message.includes("no timeouts"),
    );
    expect(frame).toBeDefined();
    expect(pauseOf().paused).toBe(false);
    // A drop holds the seat without pausing
    await clients[1].close();
    await vi.waitFor(() => expect(held().size).toBe(1));
    expect(pauseOf().paused).toBe(false);
    expect(tick()).toBeGreaterThan(0);
  });

  it("is refused to a spectator", async () => {
    await setup(new FastDuel(), "duel");
    const watcher = await ProtocolTestClient.connect(server.getPort());
    clients.push(watcher);
    watcher.send(MessageCodec.encodeJoin("Watcher"));
    await watcher.waitForType(MessageType.JoinAccept);
    watcher.send(MessageCodec.encodeCallPause(true));
    const frame = await watcher.waitFor((f) => f[0] === MessageType.ServerMessage);
    expect(MessageCodec.decodeServerMessage(frame).message).toBe("Only players can call a timeout.");
    expect(pauseOf().paused).toBe(false);
  });
});
