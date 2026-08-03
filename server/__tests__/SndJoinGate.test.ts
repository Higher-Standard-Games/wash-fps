import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageType } from "../../../../engine/network/protocol/BinaryProtocol";
import { MessageCodec } from "../../../../engine/network/protocol/MessageCodec";
import { GameServer, type GameServerConfig } from "../GameServer";
import { SearchAndDestroy } from "../gametypes/SearchAndDestroy";
import { ProtocolTestClient } from "./_protocolTestClient";

const config: GameServerConfig = {
  port: 0,
  serverName: "snd-gate",
  mapName: "test",
  maxClients: 8,
  tickRate: 125,
  snapshotRate: 60,
  certPath: "",
  keyPath: "",
};

describe("S&D join prerequisites", () => {
  let server: GameServer;
  let client: ProtocolTestClient;

  beforeEach(async () => {
    server = new GameServer(config, new SearchAndDestroy());
    await server.start();
    client = await ProtocolTestClient.connect(server.getPort());
  });

  afterEach(async () => {
    await client.close();
    await server.stop();
  });

  it("rejects spawning without a loadout and permits an immediate retry", async () => {
    client.send(MessageCodec.encodeJoin("snd-player"));
    const accept = MessageCodec.decodeJoinAccept(await client.waitForType(MessageType.JoinAccept));

    client.send(MessageCodec.encodeJoinGame("udon"));
    await client.waitForType(MessageType.ServerMessage);
    expect(server.getGametypeController().getMatchState().totalPlayers).toBe(0);

    client.send(MessageCodec.encodeSetLoadout("rlauncher", "machinegun"));
    client.send(MessageCodec.encodeJoinGame("udon"));
    const frame = await client.waitFor((data) => {
      if (data[0] !== MessageType.Snapshot) return false;
      try {
        return MessageCodec.decodeSnapshot(data).entities.has(accept.entityId);
      } catch {
        return false;
      }
    }, 4000);

    expect(frame).toBeTruthy();
    expect(server.getGametypeController().getMatchState().totalPlayers).toBe(1);
  });
});
