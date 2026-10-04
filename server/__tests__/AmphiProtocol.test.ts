/**
 * A complete Amphi score path over real sockets. The short test-only timers
 * keep the production rules intact while exercising ready, freeze, in-round
 * respawn, frag scoring, timer expiry and the terminal match result together.
 */
import type { WorldState } from "@engine/server/core/WorldState";
import { issueMatchAdmission } from "@engine/server/network/MatchAdmission";
import type { MatchResultReport } from "@engine/server/network/MatchResultReport";
import { MatchPhase } from "@shared/server/gametype";
import { afterEach, describe, expect, it } from "vitest";
import { MessageType } from "../../../../engine/network/protocol/BinaryProtocol";
import { MessageCodec } from "../../../../engine/network/protocol/MessageCodec";
import { GameServer, type GameServerConfig } from "../GameServer";
import { Amphi } from "../gametypes/Amphi";
import { type CombatSystem, DamageType, HitLocation } from "../systems/CombatSystem";
import { ProtocolTestClient } from "./_protocolTestClient";

class FastAmphi extends Amphi {
  override getMatchConfig() {
    return {
      ...super.getMatchConfig(),
      countdownDuration: 0.2,
      roundEndDuration: 0.2,
      timeLimit: 1.2,
      respawnDelay: 0.05,
      maxRespawnDelay: 0.1,
    };
  }
}

const config: GameServerConfig = {
  port: 0,
  serverName: "amphi-protocol",
  mapName: "test",
  maxClients: 2,
  tickRate: 125,
  snapshotRate: 60,
  certPath: "",
  keyPath: "",
  singleMatch: true,
};

async function waitUntil(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Amphi match did not reach the expected state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Amphi over the game server protocol", () => {
  let server: GameServer;
  const clients: ProtocolTestClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    clients.length = 0;
    if (server) await server.stop();
  });

  it("requires kits, respawns after a frag, and awards two timed rounds to the higher fragger", async () => {
    const { manifest, tickets } = issueMatchAdmission("amphi-result", [
      { lobbyPlayerId: "udon", accountId: 11, name: "Udon Player", team: "udon", isBot: false },
      { lobbyPlayerId: "soba", accountId: 12, name: "Soba Player", team: "soba", isBot: false },
    ]);
    const results: MatchResultReport[] = [];
    server = new GameServer(
      { ...config, matchAdmission: manifest, matchGametype: "amphi", onFinalResult: (r) => results.push(r) },
      new FastAmphi(),
    );
    await server.start();
    const udon = await ProtocolTestClient.connect(server.getPort());
    const soba = await ProtocolTestClient.connect(server.getPort());
    clients.push(udon, soba);

    udon.send(MessageCodec.encodeJoin("Udon Player", false, tickets.get("udon")));
    const udonSeat = MessageCodec.decodeJoinAccept(await udon.waitForType(MessageType.JoinAccept));
    soba.send(MessageCodec.encodeJoin("Soba Player", false, tickets.get("soba")));
    const sobaSeat = MessageCodec.decodeJoinAccept(await soba.waitForType(MessageType.JoinAccept));

    udon.send(MessageCodec.encodeJoinGame("udon"));
    await udon.waitForType(MessageType.ServerMessage);
    expect(server.getGametypeController().getMatchState().totalPlayers).toBe(0);

    udon.send(MessageCodec.encodeSetLoadout("rlauncher", "machinegun"));
    soba.send(MessageCodec.encodeSetLoadout("electrobolt", "riotgun"));
    udon.send(MessageCodec.encodeJoinGame("udon"));
    soba.send(MessageCodec.encodeJoinGame("soba"));
    const match = server.getGametypeController().getMatchState();
    await waitUntil(() => match.totalPlayers === 2);
    expect(match.getPlayerTeam(Number(udonSeat.playerId.replace("player_", "")) as never)).toBe("udon");
    expect(match.getPlayerTeam(Number(sobaSeat.playerId.replace("player_", "")) as never)).toBe("soba");

    udon.send(MessageCodec.encodeReady());
    soba.send(MessageCodec.encodeReady());
    const world = () => (server as unknown as { simulation: { getStateMut(): WorldState } }).simulation.getStateMut();
    const sobaId = Number(sobaSeat.playerId.replace("player_", ""));
    const udonId = Number(udonSeat.playerId.replace("player_", ""));
    const combat = (server as unknown as { combatSystem: CombatSystem }).combatSystem;

    for (let round = 1; round <= 2; round++) {
      await waitUntil(() => match.round === round && match.phase === MatchPhase.Active);
      const opponent = world().getEntityByOwner(sobaId);
      const attacker = world().getEntityByOwner(udonId);
      expect(opponent?.health?.dead).toBe(false);
      combat.queueDamage({
        victimId: opponent!.id,
        attackerId: attacker!.id,
        damage: 500,
        armorPiercing: 1,
        damageType: DamageType.Rail,
        hitLocation: HitLocation.Body,
      });
      await waitUntil(() => match.getScore(udonId as never) === 1);
      expect(match.phase).toBe(MatchPhase.Active); // a frag cannot end the round
      await waitUntil(() => world().getEntityByOwner(sobaId)?.health?.dead === false);
      await waitUntil(() => match.teamScores.get("udon") === round);
      expect(match.teamScores.get("soba")).toBe(0);
    }

    expect(match.phase).toBe(MatchPhase.PostGame);
    expect(match.toSnapshot().winner).toEqual({ kind: "team", id: "udon", name: "Udon Player" });
    expect(results).toEqual([
      expect.objectContaining({
        matchId: "amphi-result",
        gametype: "amphi",
        map: "test",
        participants: [
          { tokenHash: manifest.grants[0].tokenHash, accountId: 11, outcome: "win", score: 2 },
          { tokenHash: manifest.grants[1].tokenHash, accountId: 12, outcome: "loss", score: 0 },
        ],
      }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(match.phase).toBe(MatchPhase.PostGame); // Single-match flow cannot silently restart.
  });
});
