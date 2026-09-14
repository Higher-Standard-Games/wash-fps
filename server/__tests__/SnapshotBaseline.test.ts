import { afterEach, describe, expect, it, vi } from "vitest";
import { NetworkGameHost } from "../../../../engine/network/client/hosts/NetworkGameHost";
import { SnapshotReceiver } from "../../../../engine/network/client/SnapshotReceiver";
import type { Transport } from "../../../../engine/network/client/transport/Transport";
import { Simulation as ClientSimulation } from "../../../../engine/network/core/Simulation";
import { MessageCodec, MissingSnapshotBaselineError } from "../../../../engine/network/protocol/MessageCodec";
import type { Simulation } from "../../../../engine/server/core/Simulation";
import type { ServerPVS } from "../../../../engine/server/ServerPVS";
import { BinaryProtocol } from "../../../../shared/net/BinaryProtocol";
import { Entity } from "../../../../shared/net/Entity";
import { GameState } from "../../../../shared/net/GameState";
import type { ClientInfo } from "../Client";
import { SnapshotBroadcaster } from "../SnapshotBroadcaster";

afterEach(() => vi.restoreAllMocks());

function snapshot(tick: number, x: number, yaw = 0, grounded = false): GameState {
  const state = new GameState();
  state.tick = tick;
  const entity = new Entity("player_1");
  entity.addComponent("position", {
    x,
    y: 0,
    z: 0,
    serialize() {},
    deserialize() {},
    clone() {
      return { ...this };
    },
  });
  const transform = {
    position: { x, y: 0, z: 0 },
    rotation: { x: 0, y: yaw, z: 0, w: 1 },
    serialize() {},
    deserialize() {},
    clone() {
      return { ...this, position: { ...this.position }, rotation: { ...this.rotation } };
    },
  };
  entity.addComponent("transform", transform);
  const velocity = {
    linear: { x: 0, y: 0, z: 0 },
    grounded,
    serialize() {},
    deserialize() {},
    clone() {
      return { ...this, linear: { ...this.linear } };
    },
  };
  entity.addComponent("velocity", velocity);
  state.entities.set(entity.id, entity);
  return state;
}

function xOf(state: GameState): number | undefined {
  return (state.entities.get("player_1")?.getComponent("position") as { x: number } | undefined)?.x;
}

function setup(pvs: boolean, isVisible = () => true) {
  const packets: Uint8Array[] = [];
  const simulation = {
    getState: () => ({
      getEntity: () => ({
        transform: { position: { x: 0, y: 0, z: 0 } },
        input: { lastProcessedSeq: 0 },
      }),
    }),
  } as unknown as Simulation;
  const broadcaster = new SnapshotBroadcaster(simulation);
  if (pvs) broadcaster.setPVS({ enabled: true, isVisible } as unknown as ServerPVS);
  const client = {
    id: "qa",
    playerId: 1,
    entityId: 1,
    lastInputSeq: 0,
    lastAckedTick: 0,
    connection: { sendDatagram: (bytes: Uint8Array) => packets.push(bytes) },
  } as unknown as ClientInfo;
  return {
    client,
    broadcaster,
    send: (state: GameState) => {
      broadcaster.broadcast(new Map([[client.id, client]]), state);
      expect(packets).toHaveLength(1);
      return packets.pop()!;
    },
  };
}

describe("Snapshot baseline agreement", () => {
  it("N11: a rotation-only delta must not mutate the retained baseline", () => {
    const base = snapshot(1, 0, 0);
    const decodedBase = BinaryProtocol.decodeSnapshot(BinaryProtocol.encodeSnapshot(base));
    BinaryProtocol.decodeSnapshot(BinaryProtocol.encodeSnapshot(snapshot(2, 0, 1), base), decodedBase);
    const restored = BinaryProtocol.decodeSnapshot(BinaryProtocol.encodeSnapshot(snapshot(3, 0, 0), base), decodedBase);
    const transform = restored.entities.get("player_1")!.getComponent("transform") as unknown as {
      rotation: { y: number };
    };
    expect(transform.rotation.y).toBe(0);
  });
  it("N01: recovers a lost position change while the entity remains stationary with PVS", () => {
    const { client, send } = setup(true);
    const receiver = new SnapshotReceiver();
    receiver.receive(send(snapshot(1, 0)));
    client.lastAckedTick = 1;
    send(snapshot(2, 100)); // lost
    const received = receiver.receive(send(snapshot(3, 100)))!;
    expect(xOf(received)).toBe(100);
  });

  it.each([false, true])("N02: delayed ACK uses the named baseline (PVS=%s)", (pvs) => {
    const { client, send } = setup(pvs);
    const receiver = new SnapshotReceiver();
    receiver.receive(send(snapshot(1, 0)));
    client.lastAckedTick = 1;
    receiver.receive(send(snapshot(2, 100)));
    const received = receiver.receive(send(snapshot(3, 0)))!;
    expect(xOf(received)).toBe(0);
  });

  it("rejects missing or mismatched baselines rather than guessing", () => {
    const data = MessageCodec.encodeSnapshot(snapshot(3, 0), snapshot(1, 0));
    expect(MessageCodec.readSnapshotHeader(data)).toEqual({ tick: 3, baselineTick: 1 });
    expect(() => MessageCodec.decodeSnapshot(data)).toThrow(MissingSnapshotBaselineError);
    expect(() => MessageCodec.decodeSnapshot(data, snapshot(2, 100))).toThrow(MissingSnapshotBaselineError);
  });

  it("distinguishes tick-zero delta baselines from full snapshots", () => {
    const base = snapshot(0, 100);
    const data = MessageCodec.encodeSnapshot(snapshot(1, 100), base);
    expect(MessageCodec.readSnapshotHeader(data).baselineTick).toBe(0);
    expect(xOf(MessageCodec.decodeSnapshot(data, base))).toBe(100);
    const full = MessageCodec.encodeSnapshot(snapshot(2, 0, 0, false));
    const result = MessageCodec.decodeSnapshot(full, snapshot(1, 100, 1, true));
    expect(MessageCodec.readSnapshotHeader(full).baselineTick).toBeNull();
    expect(xOf(result)).toBe(0);
    expect(result.entities.get("player_1")!.getComponent("velocity")).toMatchObject({ grounded: false });
  });

  it("rejects the legacy wire envelope while preserving raw demo frames", () => {
    const raw = BinaryProtocol.encodeSnapshot(snapshot(1, 42));
    expect(xOf(BinaryProtocol.decodeSnapshot(raw))).toBe(42);
    expect(() => MessageCodec.decodeSnapshot(new Uint8Array([4, ...raw]))).toThrow(/legacy network snapshot/);
  });

  it("does not publish missing, stale or duplicate snapshots; full state recovers", () => {
    const receiver = new SnapshotReceiver();
    expect(receiver.receive(MessageCodec.encodeSnapshot(snapshot(3, 100), snapshot(1, 0)))).toBeNull();
    expect(xOf(receiver.receive(MessageCodec.encodeSnapshot(snapshot(4, 100)))!)).toBe(100);
    expect(receiver.receive(MessageCodec.encodeSnapshot(snapshot(2, 50)))).toBeNull();
    expect(receiver.receive(MessageCodec.encodeSnapshot(snapshot(4, 50)))).toBeNull();
    receiver.reset();
    expect(xOf(receiver.receive(MessageCodec.encodeSnapshot(snapshot(1, 0)))!)).toBe(0);
  });

  it("keeps baseline components isolated from published state and later decodes", () => {
    const receiver = new SnapshotReceiver();
    const base = snapshot(1, 0);
    const first = receiver.receive(MessageCodec.encodeSnapshot(base))!;
    Object.assign(first.entities.get("player_1")!.getComponent("position")!, { x: 999 });
    const second = receiver.receive(MessageCodec.encodeSnapshot(snapshot(2, 0, 1), base))!;
    expect(xOf(second)).toBe(0);
    Object.assign(second.entities.get("player_1")!.getComponent("position")!, { x: 888 });
    const third = receiver.receive(MessageCodec.encodeSnapshot(snapshot(3, 0, 0), base))!;
    expect(xOf(third)).toBe(0);
    expect(third.entities.get("player_1")!.getComponent("transform")).toMatchObject({ rotation: { y: 0 } });
  });

  it.each([false, true])("periodic full snapshots recover lost receiver history (PVS=%s)", (pvs) => {
    const { client, send } = setup(pvs);
    const receiver = new SnapshotReceiver();
    receiver.receive(send(snapshot(1, 0)));
    client.lastAckedTick = 1;
    receiver.reset(); // receiver no longer has the server's acknowledged baseline
    for (let tick = 2; tick < 65; tick++) {
      const data = send(snapshot(tick, 100));
      expect(MessageCodec.readSnapshotHeader(data).baselineTick).toBe(1);
      expect(receiver.receive(data)).toBeNull();
    }
    // Full states at emissions 1 and 65, with 63 intervening deltas.
    const next = send(snapshot(65, 100));
    expect(MessageCodec.readSnapshotHeader(next).baselineTick).toBeNull();
    const received = receiver.receive(next);
    expect(received).not.toBeNull();
    expect(client.sentSnapshots!.size).toBeLessThanOrEqual(64);
  });

  it("falls back to full when the sender's ACKed history entry has been evicted", () => {
    const { client, send } = setup(true);
    send(snapshot(1, 0));
    for (let tick = 2; tick <= 80; tick++) send(snapshot(tick, 100));
    expect(client.sentSnapshots!.size).toBe(64);
    client.lastAckedTick = 1;
    expect(MessageCodec.readSnapshotHeader(send(snapshot(81, 100))).baselineTick).toBeNull();
  });

  it("bounded receiver history rejects an evicted dependency without corrupting later full state", () => {
    const receiver = new SnapshotReceiver();
    for (let tick = 1; tick <= 130; tick++) receiver.receive(MessageCodec.encodeSnapshot(snapshot(tick, tick)));
    expect(receiver.receive(MessageCodec.encodeSnapshot(snapshot(131, 1), snapshot(1, 1)))).toBeNull();
    expect(xOf(receiver.receive(MessageCodec.encodeSnapshot(snapshot(132, 132)))!)).toBe(132);
  });

  it("uses the ACKed PVS subset for unchanged entities entering and leaving visibility", () => {
    let visible = false;
    const { client, send } = setup(true, () => visible);
    const receiver = new SnapshotReceiver();
    const world = (tick: number) => {
      const value = snapshot(tick, 0);
      const remote = new Entity("player_2");
      remote.addComponent("position", {
        x: 100,
        y: 0,
        z: 0,
        serialize() {},
        deserialize() {},
        clone() {
          return { ...this };
        },
      });
      value.entities.set(remote.id, remote);
      return value;
    };
    expect(receiver.receive(send(world(1)))!.entities.has("player_2")).toBe(false);
    client.lastAckedTick = 1;
    visible = true;
    expect(
      receiver
        .receive(send(world(2)))!
        .entities.get("player_2")!
        .getComponent("position"),
    ).toMatchObject({ x: 100 });
    client.lastAckedTick = 2;
    visible = false;
    expect(receiver.receive(send(world(3)))!.entities.has("player_2")).toBe(false);
    client.lastAckedTick = 3;
    visible = true;
    expect(
      receiver
        .receive(send(world(4)))!
        .entities.get("player_2")!
        .getComponent("position"),
    ).toMatchObject({ x: 100 });
  });

  it("does not retain a snapshot when sending it throws", () => {
    const { client, send, broadcaster } = setup(true);
    const receiver = new SnapshotReceiver();
    receiver.receive(send(snapshot(1, 0)));
    client.lastAckedTick = 1;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(client.connection, "sendDatagram").mockImplementationOnce(() => {
      throw new Error("send failed");
    });
    broadcaster.broadcast(new Map([[client.id, client]]), snapshot(2, 100));
    expect(client.sentSnapshots!.has(2)).toBe(false);
    expect(xOf(receiver.receive(send(snapshot(3, 100)))!)).toBe(100);
  });
});

class EmptySimulation extends ClientSimulation {
  protected createInitialState(): GameState {
    return new GameState();
  }
  protected registerSystems(): void {}
  protected registerCommandHandlers(): void {}
}

describe("NetworkGameHost snapshot acceptance", () => {
  it("ACKs and publishes only reconstructed fresh state; reconnect clears history", async () => {
    let deliver: (data: Uint8Array) => void = () => {};
    const send = vi.fn();
    const transport: Transport = {
      connect: async () => {},
      disconnect: async () => {},
      send,
      isConnected: () => true,
      onMessage: (callback) => {
        deliver = callback;
        return () => {};
      },
      onConnect: () => () => {},
      onDisconnect: () => () => {},
      onError: () => () => {},
    };
    const host = new NetworkGameHost(
      transport,
      {
        tickRate: 125,
        tickDuration: 8,
        maxPlayers: 8,
        gameRules: {},
      },
      EmptySimulation,
    );
    host.setExternalPrediction(true);
    const published = vi.fn();
    host.onStateUpdate(published);
    const base = snapshot(1, 0);
    deliver(MessageCodec.encodeSnapshot(snapshot(2, 100), base));
    expect(send).not.toHaveBeenCalled();
    expect(published).not.toHaveBeenCalled();
    deliver(MessageCodec.encodeSnapshot(base));
    deliver(MessageCodec.encodeSnapshot(snapshot(2, 100), base));
    deliver(MessageCodec.encodeSnapshot(snapshot(3, 0), base));
    expect(xOf(published.mock.calls[2][0])).toBe(0);
    expect(send.mock.calls.map(([data]) => MessageCodec.decodeAck(data).tick)).toEqual([1, 2, 3]);
    deliver(MessageCodec.encodeSnapshot(snapshot(2, 999)));
    expect(host.currentTick).toBe(3);
    expect(send).toHaveBeenCalledTimes(3);
    expect(published).toHaveBeenCalledTimes(3);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    deliver(new Uint8Array([11, 2, 0, 0, 0, 0, 4, 0, 0, 0])); // invalid hasBaseline flag
    expect(errorLog).toHaveBeenCalledOnce();
    deliver(MessageCodec.encodeSnapshot(snapshot(4, 2), base));
    expect(host.currentTick).toBe(4);
    expect(xOf(published.mock.calls[3][0])).toBe(2);
    await host.disconnect();
    deliver(MessageCodec.encodeSnapshot(snapshot(1, 50)));
    expect(host.currentTick).toBe(1);
  });
});
