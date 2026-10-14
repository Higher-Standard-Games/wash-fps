import { expect, it } from "vitest";
import { GameState } from "../../../../engine/network/core/GameState";
import { MessageCodec } from "../../../../engine/network/protocol/MessageCodec";
import type { Simulation } from "../../../../engine/server/core/Simulation";
import type { ServerPVS } from "../../../../engine/server/ServerPVS";
import type { ClientInfo } from "../Client";
import { SnapshotBroadcaster } from "../SnapshotBroadcaster";

it.each([
  false,
  true,
])("filters addressed chat before encoding with PVS=%s without mutating the shared snapshot", (pvs) => {
  const simulation = {
    getState: () => ({ getEntity: () => ({ transform: { position: { x: 0, y: 0, z: 0 } } }) }),
  } as unknown as Simulation;
  const broadcaster = new SnapshotBroadcaster(simulation);
  if (pvs) broadcaster.setPVS({ enabled: true, isVisible: () => true } as unknown as ServerPVS);
  const packets = new Map<number, Uint8Array>();
  const clients = new Map<string, ClientInfo>();
  for (const id of [1, 2])
    clients.set(String(id), {
      id: String(id),
      playerId: id,
      entityId: id,
      lastInputSeq: 0,
      lastAckedTick: 0,
      connection: { sendDatagram: (packet: Uint8Array) => packets.set(id, packet) },
    } as unknown as ClientInfo);
  const state = new GameState();
  state.tick = 1;
  state.events = [
    {
      type: "chat",
      senderId: "player_1",
      senderName: "Ada",
      team: "udon",
      text: "[TEAM] secret",
      recipientIds: ["player_1"],
    },
    { type: "chat", senderId: "player_1", senderName: "Ada", team: "udon", text: "nobody", recipientIds: [] },
    { type: "chat", senderId: "player_1", senderName: "Ada", team: "udon", text: "public" },
  ];
  broadcaster.broadcast(clients, state);
  const texts = (id: number) => MessageCodec.decodeSnapshot(packets.get(id)!).events.map((event) => event.text);
  expect(texts(1)).toEqual(["[TEAM] secret", "public"]);
  expect(texts(2)).toEqual(["public"]);
  expect(state.events).toHaveLength(3);
});
