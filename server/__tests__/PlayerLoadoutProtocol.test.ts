import { describe, expect, it } from "vitest";
import { MessageType } from "../../../../engine/network/protocol/BinaryProtocol";
import { MessageCodec } from "../../../../engine/network/protocol/MessageCodec";
import { PRIMARY_CHOICES, SECONDARY_CHOICES } from "../../../../shared/server/gametype/Loadout";
import { GameServer } from "../GameServer";
import { Amphi } from "../gametypes/Amphi";
import { Deathmatch } from "../gametypes/Deathmatch";
import { SearchAndDestroy } from "../gametypes/SearchAndDestroy";
import { ProtocolTestClient } from "./_protocolTestClient";

describe("human spawn kits over real sockets", () => {
  it.each([new Amphi(), new Deathmatch(), new SearchAndDestroy()])(
    "grants every primary/secondary combination in $name",
    async (mode) => {
      const server = new GameServer(
        {
          port: 0,
          serverName: "human kits",
          mapName: "test",
          maxClients: 32,
          tickRate: 125,
          snapshotRate: 25,
          certPath: "",
          keyPath: "",
        },
        mode,
      );
      await server.start();
      try {
        for (const primary of PRIMARY_CHOICES)
          for (const secondary of SECONDARY_CHOICES) {
            const client = await ProtocolTestClient.connect(server.getPort());
            try {
              client.send(MessageCodec.encodeJoin("Human kit test"));
              const accept = MessageCodec.decodeJoinAccept(await client.waitForType(MessageType.JoinAccept));
              client.send(MessageCodec.encodeSetLoadout(primary, secondary));
              client.send(MessageCodec.encodeJoinGame());
              const bytes = await client.waitFor((frame) => {
                if (frame[0] !== MessageType.Snapshot) return false;
                return MessageCodec.decodeSnapshot(frame).entities.has(accept.entityId);
              }, 4000);
              const state = MessageCodec.decodeSnapshot(bytes);
              expect(state.events.find((event) => event.type === "match_state")).toMatchObject({ loadouts: "respawn" });
              const kit = state.events.find(
                (event) => event.type === "weapon_state" && event.entityId === accept.entityId,
              );
              expect(kit).toMatchObject({ type: "weapon_state", weapons: ["blade", primary, secondary] });
              if (kit?.type === "weapon_state") {
                expect(kit.ammo[primary]).toBeDefined();
                expect(kit.ammo[secondary]).toBeDefined();
              }
            } finally {
              await client.close();
            }
          }
      } finally {
        await server.stop();
      }
    },
  );
});
