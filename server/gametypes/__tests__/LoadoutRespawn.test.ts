import { WorldState } from "@engine/server/core/WorldState";
import { createPlayerEntity } from "@engine/server/ecs/Entity";
import type { EntityId, PlayerId, TickNumber } from "@engine/server/ecs/types";
import { MatchPhase } from "@shared/server/gametype";
import { describe, expect, it } from "vitest";
import { CombatSystem, DamageType, HitLocation } from "../../systems/CombatSystem";
import { WeaponSystem } from "../../systems/WeaponSystem";
import { Amphi } from "../Amphi";
import type { BaseGametype } from "../BaseGametype";
import { Deathmatch } from "../Deathmatch";
import { GametypeController } from "../GametypeController";
import { SearchAndDestroy } from "../SearchAndDestroy";

const PLAYER = 7 as PlayerId,
  HERO = 11 as EntityId,
  ENEMY = 13 as EntityId;
const FIRST = { primary: "rlauncher", secondary: "machinegun" } as const;
const NEXT = { primary: "electrobolt", secondary: "riotgun" } as const;

function match(mode: BaseGametype) {
  const state = new WorldState(),
    combat = new CombatSystem(),
    weapons = new WeaponSystem(),
    controller = new GametypeController(mode);
  controller.setSubsystems(combat, weapons);
  controller.setHumanClientCount(3);
  for (const [id, owner, team] of [
    [11, 7, "udon"],
    [12, 8, "udon"],
    [13, 9, "soba"],
  ] as const) {
    mode.setPlayerLoadout(owner as PlayerId, FIRST);
    const at = controller.onPlayerJoin(owner as PlayerId, id as EntityId, state, team);
    state.addEntity(createPlayerEntity(id as EntityId, owner as PlayerId, at!));
    controller.onPlayerReady(owner as PlayerId);
  }
  let tick = 0;
  const advance = (seconds: number) => {
    for (let i = 0; i < Math.ceil(seconds * 125); i++) {
      const t = ++tick as TickNumber;
      combat.update(state, 1 / 125, t);
      controller.postTick(state, 1 / 125, t);
    }
  };
  advance(mode.getMatchConfig().countdownDuration + 1);
  expect(controller.getMatchState().phase).toBe(MatchPhase.Active);
  const die = () => {
    combat.queueDamage({
      victimId: HERO,
      attackerId: ENEMY,
      damage: 1000,
      armorPiercing: 1,
      damageType: DamageType.Bullet,
      hitLocation: HitLocation.Body,
    });
    advance(1 / 125);
    expect(state.getEntity(HERO)?.health?.dead).toBe(true);
    state.getEntityMut(HERO)!.input!.wantsRespawn = true;
  };
  return { state, weapons, controller, advance, die };
}

describe("queued loadouts at real respawn boundaries", () => {
  it.each([new Amphi(), new Deathmatch()])("applies a change on a mid-match death/respawn in $name", (mode) => {
    const game = match(mode);
    mode.setPlayerLoadout(PLAYER, NEXT);
    expect(game.weapons.getWeapons(HERO)).toEqual(["blade", "rlauncher", "machinegun"]);
    game.die();
    game.advance(4.1);
    expect(game.state.getEntity(HERO)?.health?.dead).toBe(false);
    expect(game.controller.getMatchState().phase).toBe(MatchPhase.Active);
    expect(game.controller.getMatchState().round).toBe(mode instanceof Amphi ? 1 : 0);
    expect(game.weapons.getWeapons(HERO)).toEqual(["blade", "electrobolt", "riotgun"]);
  });
  it("keeps an S&D player dead until the next round spawn, then grants the queued kit", () => {
    const mode = new SearchAndDestroy(),
      game = match(mode);
    mode.setPlayerLoadout(PLAYER, NEXT);
    expect(game.weapons.getWeapons(HERO)).toEqual(["blade", "rlauncher", "machinegun"]);
    game.die();
    game.advance(6);
    expect(game.state.getEntity(HERO)?.health?.dead).toBe(true);
    expect(game.controller.getMatchState().phase).toBe(MatchPhase.Active);
    game.controller.getMatchState().endRound("soba");
    game.advance(5.1);
    expect(game.controller.getMatchState().phase).toBe(MatchPhase.Countdown);
    expect(game.state.getEntity(HERO)?.health?.dead).toBe(false);
    expect(game.weapons.getWeapons(HERO)).toEqual(["blade", "electrobolt", "riotgun"]);
  });
});
