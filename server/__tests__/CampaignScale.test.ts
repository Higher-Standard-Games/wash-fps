/**
 * A campaign boss is bigger by its name, and only a bot: a person who takes
 * the same name stays a person's size, to hit and to move.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@engine/server/network/transport/WebSocketTransport", () => import("./_fakeTransport"));

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
  campaign: "siege-breaker",
  campaignRules: { scales: { Siege_Bot: 2.5 } },
};

// biome-ignore lint/suspicious/noExplicitAny: reach into private server internals
type Inner = any;

describe("campaign scale", () => {
  it("makes the named bot bigger, and not a person with its name", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const inner: Inner = new GameServer(config, new Deathmatch());
    inner.clients.set("bot", { playerId: 1, entityId: 10, playerName: "Siege_Bot", isBot: true });
    inner.clients.set("person", { playerId: 2, entityId: 20, playerName: "Siege_Bot", isBot: false });
    expect(inner.campaignScaleOf(10)).toBe(2.5);
    expect(inner.campaignScaleOf(20)).toBe(1);
    vi.restoreAllMocks();
  });
});
