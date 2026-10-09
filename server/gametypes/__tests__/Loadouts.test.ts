/**
 * Kits in S&D, Amphi and Deathmatch: when a chosen kit applies, which modes
 * leave weapons off the map, and the kits bots carry.
 */
import type { PlayerId } from "@engine/server/ecs/types";
import { botLoadout, type LoadoutChoice, PRIMARY_CHOICES, SECONDARY_CHOICES } from "@shared/server/gametype";
import { describe, expect, it } from "vitest";
import { WEAPON_PICKUP_CLASSNAMES } from "../../../../../shared/bsp/PickupTable";
import { Amphi } from "../Amphi";
import { Deathmatch } from "../Deathmatch";
import { Duel } from "../Duel";
import { PlayerLoadouts } from "../PlayerLoadouts";
import { SearchAndDestroy } from "../SearchAndDestroy";
import { TeamDeathmatch } from "../TeamDeathmatch";

const P = 7 as PlayerId;
const ROCKET: LoadoutChoice = { primary: "rlauncher", secondary: "machinegun" };
const BOLT: LoadoutChoice = { primary: "electrobolt", secondary: "riotgun" };
const weaponsOf = (kit: { weapons: string[] }) => kit.weapons;

describe("player kits", () => {
  it("arms a player's first choice at once", () => {
    for (const mode of ["round", "respawn"] as const) {
      const kits = new PlayerLoadouts(mode);
      expect(kits.has(P)).toBe(false);
      kits.choose(P, BOLT);
      expect(kits.has(P)).toBe(true);
      expect(weaponsOf(kits.spawnKit(P))).toEqual(["blade", "electrobolt", "riotgun"]);
    }
  });

  it("holds a change for the next round in a round mode", () => {
    const kits = new PlayerLoadouts("round");
    kits.choose(P, ROCKET);
    kits.choose(P, BOLT);
    expect(weaponsOf(kits.spawnKit(P))).toContain("rlauncher");
    expect(kits.next(P)).toEqual(BOLT);
    kits.startRound();
    expect(weaponsOf(kits.spawnKit(P))).toContain("electrobolt");
  });

  it("applies a change at the next spawn in a respawning mode", () => {
    const kits = new PlayerLoadouts("respawn");
    kits.choose(P, ROCKET);
    kits.choose(P, BOLT);
    expect(kits.next(P)).toEqual(BOLT);
    expect(weaponsOf(kits.spawnKit(P))).toContain("electrobolt");
  });

  it("spawns Deathmatch kits with Deathmatch's own armor, and round kits with 100", () => {
    const dm = new Deathmatch();
    dm.setPlayerLoadout(P, ROCKET);
    expect(dm.getSpawnLoadout(P)).toMatchObject({ health: 100, armor: 0 });
    const amphi = new Amphi();
    amphi.setPlayerLoadout(P, ROCKET);
    expect(amphi.getSpawnLoadout(P)).toMatchObject({ health: 100, armor: 100 });
  });

  it("gates joining on a chosen kit only in the round modes", () => {
    expect(new SearchAndDestroy().hasChosenLoadout(P)).toBe(false);
    expect(new Amphi().hasChosenLoadout(P)).toBe(false);
    // Deathmatch's client picker blocks the join; the server spawns a player who never chose with the default kit
    expect(new Deathmatch().hasChosenLoadout(P)).toBe(true);
    expect(weaponsOf(new Deathmatch().getSpawnLoadout(P))).toEqual(["blade", "rlauncher", "machinegun"]);
  });

  it("forgets a player who leaves", () => {
    const kits = new PlayerLoadouts("respawn");
    kits.choose(P, BOLT);
    kits.forget(P);
    expect(kits.has(P)).toBe(false);
  });
});

describe("weapons on the map", () => {
  it("are left off wherever players choose a kit, and stay in Duel and Team Deathmatch", () => {
    for (const mode of [new SearchAndDestroy(), new Amphi(), new Deathmatch()]) {
      expect(mode.getMatchConfig().loadouts, mode.name).toBeDefined();
      expect(mode.getItemSpawnRules().excludeClassnames, mode.name).toEqual(
        expect.arrayContaining([...WEAPON_PICKUP_CLASSNAMES]),
      );
    }
    for (const mode of [new Duel(), new TeamDeathmatch()]) {
      expect(mode.getMatchConfig().loadouts, mode.name).toBeUndefined();
      const excluded = mode.getItemSpawnRules().excludeClassnames ?? [];
      expect(
        excluded.some((name) => name.startsWith("weapon_")),
        mode.name,
      ).toBe(false);
    }
  });

  it("covers every weapon classname, the Warsow lasergun alias included", () => {
    expect(WEAPON_PICKUP_CLASSNAMES).toEqual(expect.arrayContaining(["weapon_rocketlauncher", "weapon_lasergun"]));
  });
});

describe("bot kits", () => {
  it("are real choices, the same for the same bot, and not all the same", () => {
    const kits = Array.from({ length: 12 }, (_, i) => botLoadout(900 + i));
    for (const kit of kits) {
      expect(PRIMARY_CHOICES).toContain(kit.primary);
      expect(SECONDARY_CHOICES).toContain(kit.secondary);
    }
    expect(botLoadout(905)).toEqual(kits[5]);
    expect(new Set(kits.map((kit) => `${kit.primary}/${kit.secondary}`)).size).toBeGreaterThan(3);
  });
});
