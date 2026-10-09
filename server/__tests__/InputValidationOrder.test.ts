/**
 * The order a movement command is checked in: de-dup, then the anti-warp
 * validator, then the sanitiser.
 *
 * Clients send each command three times for packet loss, so a redundant copy
 * must never spend the validator's per-tick allowance, and a command the
 * validator drops must not count as processed, or its next copy is lost too.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@engine/server/network/transport/WebSocketTransport", () => import("./_fakeTransport"));

import { createPlayerEntity } from "@engine/server/ecs/Entity";
import { MessageCodec } from "../../../../engine/network/protocol/MessageCodec";
import { GameServer, type GameServerConfig } from "../GameServer";
import { Deathmatch } from "../gametypes/Deathmatch";

const config: GameServerConfig = {
  port: 0,
  serverName: "test",
  mapName: "test",
  maxClients: 8,
  tickRate: 125,
  snapshotRate: 60,
  certPath: "",
  keyPath: "",
};

// biome-ignore lint/suspicious/noExplicitAny: reach into private server internals
type Inner = any;

function setup() {
  const inner: Inner = new GameServer(config, new Deathmatch());
  const client = { playerId: 7, entityId: 70, isSpectator: false, lastInputSeq: 0 };
  inner.simulation.getStateMut().addEntity(createPlayerEntity(70 as never, 7 as never, { x: 0, y: 0, z: 0 }));
  inner.movementValidator.addClient(client.playerId);
  const validate = vi.spyOn(inner.movementValidator, "validateInput");
  const send = (seq: number) =>
    inner.handleInput(client, MessageCodec.encodeCommand("7", seq, { direction: { x: 0, y: 0, z: 1 } }));
  return { inner, client, validate, send };
}

describe("movement command checks", () => {
  afterEach(() => vi.restoreAllMocks());

  it("never asks the validator about a redundant copy", () => {
    const { client, validate, send } = setup();
    send(1);
    send(1);
    send(1);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(client.lastInputSeq).toBe(1);
  });

  it("does not count a command the validator dropped as processed", () => {
    const { client, validate, send } = setup();
    validate.mockReturnValueOnce(false);
    send(1);
    expect(client.lastInputSeq).toBe(0);
    // Its next copy gets through.
    send(1);
    expect(client.lastInputSeq).toBe(1);
  });

  it("rate-caps a malformed flood before the sanitiser sees it", () => {
    const { inner, client, validate, send } = setup();
    const violation = vi.spyOn(inner.telemetry, "recordViolation");
    validate.mockReturnValue(false);
    send(5);
    expect(violation).not.toHaveBeenCalled();
    expect(client.lastInputSeq).toBe(0);
  });
});
