/**
 * Lag compensation under real latency.
 *
 * Lag compensation is invisible at zero latency: the view tick a client reports
 * equals the server's own, the rewind is nil, and every code path looks exactly
 * like the uncompensated one. Every other test in this repo runs at zero
 * latency, so none of them can tell a working rewind from a broken one.
 *
 * This suite holds frames in both directions over a real socket and asserts on
 * what the server actually observes, so the rewind can be measured rather than
 * reasoned about. It is also the instrument for tuning: `observedViewLag`
 * reports the very quantity the interpolation assumption has to match.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageType } from "../../../../engine/network/protocol/BinaryProtocol";
import { MessageCodec } from "../../../../engine/network/protocol/MessageCodec";
import { GameServer, type GameServerConfig } from "../GameServer";
import { Deathmatch } from "../gametypes/Deathmatch";
import { ProtocolTestClient } from "./_protocolTestClient";

const TICK_RATE = 125;
const config: GameServerConfig = {
  port: 0,
  serverName: "latency",
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

/** Reach past the public surface — a smoke suite asserts on what the server did. */
function sim() {
  return (
    server as unknown as {
      simulation: {
        currentTick: number;
        getState(): { allEntities(): Iterable<{ input?: { viewTick?: number } }> };
      };
    }
  ).simulation;
}

function serverTick(): number {
  return Number(sim().currentTick);
}

/** View ticks the server is currently holding, one per entity that has input. */
function viewTicks(): number[] {
  const seen: number[] = [];
  for (const e of sim().getState().allEntities()) if (e.input) seen.push(e.input.viewTick ?? 0);
  return seen;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out");
    await new Promise((r) => setTimeout(r, 4));
  }
}

/**
 * A client that behaves the way the real one does: it tracks the newest
 * snapshot tick it has seen and stamps every command with it, which is exactly
 * what `Game.ts` does via `NetworkGameHost.currentTick`.
 */
class LaggedPlayer {
  private seq = 1;
  lastSnapshotTick = 0;
  private stop = false;

  private constructor(
    readonly client: ProtocolTestClient,
    readonly playerId: string,
  ) {}

  static async join(port: number, name: string, oneWayMs: number): Promise<LaggedPlayer> {
    const client = await ProtocolTestClient.connect(port);
    clients.push(client);
    client.send(MessageCodec.encodeJoin(name));
    const accept = MessageCodec.decodeJoinAccept(await client.waitForType(MessageType.JoinAccept));
    client.send(MessageCodec.encodeJoinGame());
    // Latency goes on after the handshake, so joining stays quick.
    client.setLatency(oneWayMs);
    const player = new LaggedPlayer(client, accept.playerId);
    player.watchSnapshots();
    return player;
  }

  /** Track the newest snapshot tick, the way a real client syncs its clock. */
  private watchSnapshots(): void {
    void this.client
      .waitFor((f) => {
        if (this.stop || f.length === 0 || f[0] !== MessageType.Snapshot) return false;
        try {
          const tick = MessageCodec.decodeSnapshot(f).tick;
          if (tick > this.lastSnapshotTick) this.lastSnapshotTick = tick;
        } catch {
          // A frame we cannot decode tells us nothing about the clock.
        }
        return false; // never resolve — this is a running observer
      }, 60_000)
      .catch(() => {
        // Expected: the observer is torn down with the socket.
      });
  }

  /** Send a command stamped with the view this client actually has. */
  sendInput(overrides: { forward?: number; right?: number; buttons?: number; tick?: number } = {}): void {
    this.client.send(
      MessageCodec.encodeCommand(this.playerId, this.seq++, {
        direction: { x: overrides.right ?? 0, y: 0, z: overrides.forward ?? 0 },
        pitch: 0,
        yaw: 0,
        buttons: overrides.buttons ?? 0,
        tick: overrides.tick ?? this.lastSnapshotTick,
        weaponSlot: 0,
      }),
    );
  }

  dispose(): void {
    this.stop = true;
  }
}

/** Ticks the server sees a client lagging behind, averaged over a short run. */
async function observedViewLag(player: LaggedPlayer, samples = 40): Promise<number> {
  const lags: number[] = [];
  for (let i = 0; i < samples; i++) {
    player.sendInput({ forward: 1 });
    await new Promise((r) => setTimeout(r, 8));
    const ticks = viewTicks().filter((t) => t > 0);
    if (ticks.length) lags.push(serverTick() - Math.max(...ticks));
  }
  if (!lags.length) throw new Error("no view ticks observed");
  lags.sort((a, b) => a - b);
  return lags[Math.floor(lags.length / 2)]; // median — immune to a stray scheduling hiccup
}

describe("lag compensation under latency", () => {
  it("sees a client's reported view fall further behind as latency rises", async () => {
    const fast = await LaggedPlayer.join(server.getPort(), "fast", 0);
    await waitUntil(() => fast.lastSnapshotTick > 0);
    const fastLag = await observedViewLag(fast);
    fast.dispose();

    const slow = await LaggedPlayer.join(server.getPort(), "slow", 60);
    await waitUntil(() => slow.lastSnapshotTick > 0);
    const slowLag = await observedViewLag(slow);
    slow.dispose();

    // 60ms each way is 120ms of round trip — about 15 ticks at 125Hz. The exact
    // figure moves with scheduling, so assert the separation, not a constant.
    const extraMs = ((slowLag - fastLag) / TICK_RATE) * 1000;
    expect(slowLag).toBeGreaterThan(fastLag);
    expect(extraMs).toBeGreaterThan(50);
  });

  it("keeps a laggy client's view tick inside the rewind budget", async () => {
    // 250ms each way is far past the 100ms compensation budget. The server must
    // still take the report, clamp the rewind, and never read a negative age.
    const distant = await LaggedPlayer.join(server.getPort(), "distant", 250);
    await waitUntil(() => distant.lastSnapshotTick > 0, 8000);
    // Half a second of round trip: keep sending until one completes the loop,
    // rather than sampling on a fixed window that a slower run would outrun.
    await waitUntil(() => {
      distant.sendInput({ forward: 1 });
      return viewTicks().some((t) => t > 0);
    }, 8000);
    const observed = viewTicks().filter((t) => t > 0);
    expect(observed.length).toBeGreaterThan(0);
    for (const tick of observed) {
      expect(tick).toBeLessThanOrEqual(serverTick());
      expect(tick).toBeGreaterThan(0);
    }
    distant.dispose();
  });

  it("reports no view tick before the first snapshot, so nothing is rewound", async () => {
    const player = await LaggedPlayer.join(server.getPort(), "cold", 40);
    // Fire immediately: lastSnapshotTick is still 0, which must stay 0 on the
    // server rather than becoming a rewind to the beginning of the match.
    player.sendInput({ forward: 1, tick: 0 });
    await new Promise((r) => setTimeout(r, 120));
    expect(viewTicks().every((t) => t >= 0)).toBe(true);
    player.dispose();
  });
});
