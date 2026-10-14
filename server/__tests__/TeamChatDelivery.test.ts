import { afterEach, expect, it } from "vitest";
import { MessageType } from "../../../../engine/network/protocol/BinaryProtocol";
import { MessageCodec } from "../../../../engine/network/protocol/MessageCodec";
import { GameServer } from "../GameServer";
import { Deathmatch } from "../gametypes/Deathmatch";
import { TeamDeathmatch } from "../gametypes/TeamDeathmatch";
import { ProtocolTestClient } from "./_protocolTestClient";

let server: GameServer;
const clients: ProtocolTestClient[] = [];
afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  clients.length = 0;
  await server?.stop();
});
const chatTexts = (client: ProtocolTestClient) =>
  client.frames.flatMap((frame) => {
    if (frame[0] !== MessageType.Snapshot) return [];
    return MessageCodec.decodeSnapshot(frame)
      .events.filter((event) => event.type === "chat")
      .map((event) => event.text);
  });
async function join(name: string, play = true) {
  const client = await ProtocolTestClient.connect(server.getPort());
  clients.push(client);
  client.send(MessageCodec.encodeJoin(name));
  await client.waitForType(MessageType.JoinAccept);
  if (play) {
    client.send(MessageCodec.encodeJoinGame());
    // Wait for the play admission acknowledgement, not a fixed delay.
    await client.waitForType(MessageType.JoinAccept);
  }
  return client;
}
async function start(team = true) {
  server = new GameServer(
    {
      port: 0,
      serverName: "chat",
      mapName: "test",
      maxClients: 8,
      tickRate: 125,
      snapshotRate: 60,
      certPath: "",
      keyPath: "",
    },
    team ? new TeamDeathmatch() : new Deathmatch(),
  );
  await server.start();
}

it("delivers team chat to its sender and teammates only, while global chat reaches everyone", async () => {
  await start();
  const sender = await join("sender");
  const enemy = await join("enemy");
  const ally = await join("ally");
  const spectator = await join("watcher", false);
  sender.send(MessageCodec.encodeChat("/say_team shit hold site"));
  await ally.waitFor(
    (frame) => frame[0] === MessageType.Snapshot && chatTexts(ally).includes("[TEAM] *** hold site"),
    3000,
  );
  expect(chatTexts(sender)).toContain("[TEAM] *** hold site");
  expect(chatTexts(sender)).not.toContain("[TEAM] shit hold site");
  // Wait beyond delivery for another complete snapshot on every connection.
  await Promise.all([enemy, spectator].map((client) => client.waitForType(MessageType.Snapshot)));
  expect(chatTexts(enemy)).not.toContain("[TEAM] *** hold site");
  expect(chatTexts(spectator)).not.toContain("[TEAM] *** hold site");
  enemy.send(MessageCodec.encodeChat("shit hello all"));
  await Promise.all(
    [sender, ally, spectator].map((client) =>
      client.waitFor((frame) => frame[0] === MessageType.Snapshot && chatTexts(client).includes("*** hello all"), 3000),
    ),
  );
  expect(chatTexts(enemy)).toContain("*** hello all");
  spectator.send(MessageCodec.encodeChat("/say_team spy"));
  await spectator.waitFor(
    (frame) =>
      frame[0] === MessageType.ServerMessage && MessageCodec.decodeServerMessage(frame).message.includes("Team chat"),
  );
  expect(chatTexts(sender)).not.toContain("[TEAM] spy");
});

it("rejects team chat in free-for-all instead of broadcasting it globally", async () => {
  await start(false);
  const player = await join("player");
  player.send(MessageCodec.encodeChat("/say_team private"));
  await player.waitFor(
    (frame) =>
      frame[0] === MessageType.ServerMessage && MessageCodec.decodeServerMessage(frame).message.includes("Team chat"),
  );
  expect(chatTexts(player)).not.toContain("[TEAM] private");
});

it("masks spectator chat before sender echo and delivery to players", async () => {
  await start(false);
  const player = await join("player");
  const spectator = await join("watcher", false);
  spectator.send(MessageCodec.encodeChat("fuckj nice shot"));
  await Promise.all(
    [player, spectator].map((client) =>
      client.waitFor((frame) => frame[0] === MessageType.Snapshot && chatTexts(client).includes("***j nice shot"), 3000),
    ),
  );
  for (const client of [player, spectator]) expect(chatTexts(client)).not.toContain("fuckj nice shot");
});
