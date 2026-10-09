/**
 * Amphi rounds start clean: nobody carries a Quad into the next round, and the
 * map's items, the Quad's timer among them, start over.
 */
import { WorldState } from "@engine/server/core/WorldState";
import { createPlayerEntity } from "@engine/server/ecs/Entity";
import type { EntityId, PlayerId, TickNumber } from "@engine/server/ecs/types";
import { MatchPhase } from "@shared/server/gametype";
import { createPowerups, grantPowerup } from "@shared/server/simulation/components/PowerupComponent";
import { describe, expect, it, vi } from "vitest";
import { CombatSystem } from "../../systems/CombatSystem";
import { Amphi } from "../Amphi";
import { GametypeController } from "../GametypeController";

const P1 = 1 as PlayerId;
const P2 = 2 as PlayerId;

describe("Amphi round start", () => {
  it("takes the Quad off its carrier and resets the map at the next round", () => {
    const controller = new GametypeController(new Amphi());
    controller.setSubsystems(new CombatSystem(), {
      dropAllWeapons: () => {},
      initializeWeaponFromLoadout: () => {},
    } as never);
    const reset = vi.fn();
    controller.setMatchStartReset(reset);
    const match = controller.getMatchState();
    match.addPlayer(P1);
    match.addPlayer(P2);
    match.setPlayerTeam(P1, "udon");
    match.setPlayerTeam(P2, "soba");

    const state = new WorldState();
    for (const [eid, pid] of [
      [11, P1],
      [12, P2],
    ] as const) {
      state.addEntity(createPlayerEntity(eid as EntityId, pid, { x: eid * 100, y: 0, z: 0 }));
    }
    let tick = 1;
    const step = () => controller.postTick(state, 1 / 125, tick++ as TickNumber);

    match.transition(MatchPhase.Countdown);
    step();
    match.transition(MatchPhase.Active);
    step();
    reset.mockClear();

    // Round one: player 1 takes the Quad
    const carrier = state.getEntityMut(11 as EntityId)!;
    carrier.powerups = createPowerups();
    grantPowerup(carrier.powerups, "quad", tick, 125);
    expect(carrier.powerups.expiry.quad).toBeGreaterThan(tick);

    // The round is decided; the intermission runs out into the next round's freeze
    match.endRound("udon");
    step();
    controller.postTick(state, 4.5, tick++ as TickNumber);
    expect(match.phase).toBe(MatchPhase.Countdown);

    expect(reset).toHaveBeenCalledOnce();
    const after = state.getEntity(11 as EntityId)!;
    expect(after.powerups?.expiry.quad ?? 0).toBeLessThanOrEqual(tick);
  });
});
