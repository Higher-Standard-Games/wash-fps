/**
 * The bomb's blast is a show, not a frag.
 *
 * It lands in the round-end intermission and is credited to no one, so a
 * player it gibs loses no score and gets no death, and no one gets a frag.
 */
import { WorldState } from "@engine/server/core/WorldState";
import { createPlayerEntity } from "@engine/server/ecs/Entity";
import type { EntityId, PlayerId, TickNumber } from "@engine/server/ecs/types";
import { MatchPhase } from "@shared/server/gametype";
import { describe, expect, it } from "vitest";
import { CombatSystem, DamageType } from "../../systems/CombatSystem";
import { GametypeController } from "../GametypeController";
import { SearchAndDestroy } from "../SearchAndDestroy";

const P1 = 1 as PlayerId;
const P2 = 2 as PlayerId;

function setup(phase: MatchPhase) {
  const controller = new GametypeController(new SearchAndDestroy());
  const combat = new CombatSystem();
  controller.setSubsystems(combat, { dropAllWeapons: () => {} } as never);
  const match = controller.getMatchState();
  match.addPlayer(P1);
  match.addPlayer(P2);
  match.setPlayerTeam(P1, "udon");
  match.setPlayerTeam(P2, "soba");
  match.transition(MatchPhase.Countdown);
  match.transition(MatchPhase.Active);
  if (phase !== MatchPhase.Active) match.transition(phase);

  const state = new WorldState();
  for (const [eid, pid] of [
    [11, P1],
    [12, P2],
  ] as const) {
    state.addEntity(createPlayerEntity(eid as EntityId, pid, { x: eid, y: 0, z: 0 }));
  }

  const internals = controller as unknown as {
    tickContext(tick: TickNumber): { blast(id: EntityId, damage: number, push: object): void };
  };
  /** One blast hitting entity 12, and the tick that applies it. */
  const blast = (damage: number) => {
    internals.tickContext(1 as TickNumber).blast(12 as EntityId, damage, { x: 1, y: 0, z: 0 });
    combat.update(state, 1 / 125, 1 as TickNumber);
    const kills = combat.getRecentKills();
    controller.postTick(state, 1 / 125, 1 as TickNumber);
    return kills;
  };
  return { match, state, blast };
}

describe("bomb blast", () => {
  it("gibs through armor as a death credited to no one", () => {
    const { state, blast } = setup(MatchPhase.RoundEnd);
    const kills = blast(250);
    expect(kills).toHaveLength(1);
    expect(kills[0]).toMatchObject({ victimId: 12, killerId: undefined, damageType: DamageType.Bomb });
    expect(state.getEntity(12 as EntityId)?.health?.dead).toBe(true);
  });

  it("costs the victim nothing and gives no one anything in the intermission", () => {
    const { match, blast } = setup(MatchPhase.RoundEnd);
    blast(250);
    expect(match.getScore(P2)).toBe(0);
    expect(match.getDeaths(P2)).toBe(0);
    expect(match.getScore(P1)).toBe(0);
  });

  it("would count as a death in a live round, which is why the blasts wait for the intermission", () => {
    const { match, blast } = setup(MatchPhase.Active);
    blast(250);
    expect(match.getDeaths(P2)).toBe(1);
    expect(match.getScore(P2)).toBe(0);
  });
});
