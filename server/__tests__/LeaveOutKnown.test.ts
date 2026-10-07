/**
 * SnapshotBroadcaster leaves out lasting state a client already holds, and only that.
 * Convergence under loss is SnapshotConvergence.test.ts; this pins the rule itself.
 */

import { entityId, playerId } from "@engine/server/ecs/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameState } from "../../../../engine/network/core/GameState";
import { MessageCodec } from "../../../../engine/network/protocol/MessageCodec";
import { broadcastContext } from "../../bench/fixtures";
import { toClientKey } from "../../ClientEntityKey";
import type { ClientInfo } from "../Client";
import { SnapshotBroadcaster } from "../SnapshotBroadcaster";
import { buildSnapshot } from "../SnapshotBuilder";

function setup() {
  const { ctx } = broadcastContext({ players: 4, projectiles: 0, droppedWeapons: 0, damageEvents: 0 });
  const broadcaster = new SnapshotBroadcaster(ctx.simulation);
  const client = (ctx.clients as Map<string, ClientInfo>).get("client_1") as ClientInfo;
  const sentTo = new Map<string, GameState>();
  const encode = MessageCodec.encodeSnapshot.bind(MessageCodec);
  let current = "";
  vi.spyOn(MessageCodec, "encodeSnapshot").mockImplementation((state, baseline) => {
    sentTo.set(current, state);
    return encode(state, baseline);
  });
  /** Send one snapshot; return what client_1 got. */
  const send = () => {
    ctx.simulation.tick();
    const state = buildSnapshot(ctx);
    const clients = new Map([[client.id, client]]);
    current = client.id;
    broadcaster.broadcast(clients, state);
    return { shared: state, got: sentTo.get(client.id) as GameState };
  };
  const matchState = (state: GameState) => state.events.find((event) => event.type === "match_state");
  return { ctx, client, send, matchState };
}

describe("leaving out the roster a client holds", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends it until a snapshot carrying it is acked, then leaves it out", () => {
    const { client, send, matchState } = setup();
    const first = send();
    expect(matchState(first.got)?.standings).toHaveLength(4);
    const second = send();
    expect(matchState(second.got)?.standings).toHaveLength(4); // nothing acked yet

    client.lastAckedTick = first.got.tick;
    const third = send();
    expect(matchState(third.got)?.standings).toBeUndefined();
    expect(matchState(third.got)?.rosterOmitted).toBe(true);
    expect(matchState(third.got)?.phase).toBe(matchState(third.shared)?.phase);
    // The shared snapshot, which the demo records, keeps everything.
    expect(matchState(third.shared)?.standings).toHaveLength(4);
    expect(matchState(third.shared)?.rosterOmitted).toBeUndefined();
  });

  it("sends it again from the tick it changes until that tick is acked", () => {
    const { ctx, client, send, matchState } = setup();
    client.lastAckedTick = send().got.tick;
    expect(matchState(send().got)?.rosterOmitted).toBe(true);

    ctx.gametypeController.getMatchState().addDeath(playerId(2));
    const changed = send();
    expect(matchState(changed.got)?.standings).toBeDefined();
    expect(matchState(send().got)?.standings).toBeDefined(); // the change is not acked yet
    client.lastAckedTick = changed.got.tick;
    expect(matchState(send().got)?.rosterOmitted).toBe(true);
  });

  it("does not count an ack from before a change as holding the new value", () => {
    const { ctx, client, send, matchState } = setup();
    const before = send();
    ctx.gametypeController.getMatchState().addDeath(playerId(3));
    send();
    client.lastAckedTick = before.got.tick;
    expect(matchState(send().got)?.standings).toBeDefined();
  });

  it("sends everything again every 125th snapshot, whatever was acked", () => {
    const { client, send, matchState } = setup();
    let carried = 0;
    for (let i = 0; i < 250; i++) {
      const { got } = send();
      client.lastAckedTick = got.tick;
      if (matchState(got)?.standings) carried++;
    }
    // The first snapshot, the one after it (acked only then), and one refresh per 125 after that.
    expect(carried).toBeLessThanOrEqual(4);
    expect(carried).toBeGreaterThanOrEqual(2);
  });
});

describe("leaving out other players' weapon state a client holds", () => {
  afterEach(() => vi.restoreAllMocks());

  const weaponsIn = (state: GameState) =>
    state.events.filter((event) => event.type === "weapon_state").map((event) => String(event.entityId));

  it("always sends the client its own, and others only until acked or changed", () => {
    const { ctx, client, send } = setup();
    const own = toClientKey(client.entityId);
    const first = send();
    expect(weaponsIn(first.got)).toHaveLength(4);
    client.lastAckedTick = first.got.tick;
    expect(weaponsIn(send().got)).toEqual([own]);

    const other = ctx.weaponSystem.getWeaponState(entityId(3));
    if (!other) throw new Error("no weapon state");
    other.lastFireTick = 999;
    const changed = send();
    expect(weaponsIn(changed.got).sort()).toEqual([own, toClientKey(entityId(3))].sort());
    expect(weaponsIn(changed.shared)).toHaveLength(4);
    client.lastAckedTick = changed.got.tick;
    expect(weaponsIn(send().got)).toEqual([own]);
  });
});
