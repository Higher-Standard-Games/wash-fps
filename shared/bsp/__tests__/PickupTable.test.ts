/**
 * PickupTable.test.ts - locks the shared pickup extractor that gives the server
 * and client identical pickup ids across all tracked types.
 */

import { describe, expect, it } from "vitest";
import {
  CLASSNAME_TO_WEAPON,
  extractPickups,
  extractWeaponPickups,
  mapModeKeys,
  PICKUP_CLASSNAMES,
  spawnsIn,
} from "../PickupTable";

type Ent = { classname: string; properties: Record<string, string> };

const ent = (classname: string, origin?: string): Ent => ({
  classname,
  properties: origin ? { origin } : {},
});

describe("extractPickups", () => {
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "ignores the unknown classname %s without consuming a pickup id",
    (classname) => {
      const entities = [
        ent("item_health_medium", "0 0 0"),
        ent(classname, "1 2 3"),
        ent("weapon_rocketlauncher", "100 200 16"),
        ent("item_quad", "10 20 30"),
      ];
      expect(extractPickups(entities).map((pickup) => [pickup.id, pickup.type, pickup.kind])).toEqual([
        [0, "health", "medium"],
        [1, "weapon", "rlauncher"],
        [2, "powerup", "quad"],
      ]);
      expect(extractWeaponPickups(entities).map((pickup) => pickup.id)).toEqual([1]);
    },
  );

  it("keeps weapon/ammo/armor/health classnames in BSP order with one shared id space", () => {
    const out = extractPickups([
      ent("worldspawn"),
      ent("info_player_deathmatch", "0 0 0"),
      ent("weapon_rocketlauncher", "100 200 16"),
      ent("ammo_rockets", "120 220 16"),
      ent("item_armor_ga", "50 50 0"),
      ent("misc_model", "1 1 1"),
      ent("item_health_mega", "300 400 16"),
    ]);
    expect(out.map((e) => [e.id, e.type, e.kind, e.amount])).toEqual([
      [0, "weapon", "rlauncher", undefined],
      [1, "ammo", "rockets", 10],
      [2, "armor", "ga", undefined],
      [3, "health", "mega", undefined],
    ]);
  });

  it("converts a Z-up BSP origin to Y-up game coordinates", () => {
    const [rl] = extractPickups([ent("weapon_rocketlauncher", "100 200 16")]);
    expect(rl.position).toEqual({ x: 100, y: 16, z: 200 });
  });

  it.each(["100  200 16", " 100 200 16 ", "100\t200\t16", "100 \t200\n16"])(
    "parses whitespace-separated pickup origins: %j",
    (origin) => {
      const pickups = extractPickups([ent("weapon_rocketlauncher", origin), ent("ammo_rockets", "120 220 16")]);
      expect(pickups).toMatchObject([
        { id: 0, kind: "rlauncher", position: { x: 100, y: 16, z: 200 } },
        { id: 1, kind: "rockets", position: { x: 120, y: 16, z: 220 } },
      ]);
    },
  );

  it.each(["   ", "1 2", "1 2 3 4", "1 Infinity 3"])(
    "skips malformed pickup origins without consuming an id: %j",
    (origin) => {
      const pickups = extractPickups([ent("item_health_medium", origin), ent("weapon_rocketlauncher", "100 200 16")]);
      expect(pickups).toMatchObject([{ id: 0, kind: "rlauncher", position: { x: 100, y: 16, z: 200 } }]);
    },
  );

  it("maps registered ammo, armor and health classnames to the right kinds", () => {
    const out = extractPickups([
      ent("ammo_rockets", "0 0 0"),
      ent("ammo_plasmagun", "0 0 0"),
      ent("item_armor_shard", "0 0 0"),
      ent("item_armor_ya", "0 0 0"),
      ent("item_armor_ra", "0 0 0"),
      ent("item_health_small", "0 0 0"),
      ent("item_health_large", "0 0 0"),
      ent("item_health_ultra", "0 0 0"),
    ]);
    expect(out.map((e) => `${e.type}:${e.kind}:${e.amount ?? ""}`)).toEqual([
      "ammo:rockets:10",
      "ammo:cells:50",
      "armor:shard:",
      "armor:ya:",
      "armor:ra:",
      "health:small:",
      "health:large:",
      "health:ultra:",
    ]);
  });

  it("maps weapon-specific ammo classnames to their ammo pools", () => {
    const out = extractPickups([
      ent("ammo_machinegun", "0 0 0"),
      ent("ammo_riotgun", "0 0 0"),
      ent("ammo_grenadelauncher", "0 0 0"),
      ent("ammo_rocketlauncher", "0 0 0"),
      ent("ammo_lasergun", "0 0 0"),
      ent("ammo_electrobolt", "0 0 0"),
    ]);
    expect(out.map((e) => `${e.kind}:${e.amount}`)).toEqual([
      "bullets:50",
      "shells:10",
      "grenades:10",
      "rockets:10",
      // ammo_lasergun feeds the beam's own `lasers` pool, not the plasmagun's cells.
      "lasers:100",
      "bolts:10",
    ]);
  });

  it("keeps laser and plasma ammo in separate pools", () => {
    const out = extractPickups([ent("ammo_plasmagun", "0 0 0"), ent("ammo_lasergun", "0 0 0")]);
    expect(out.map((e) => e.kind)).toEqual(["cells", "lasers"]);
  });

  it("tracks item_quad as a powerup and leaves unimplemented powerups alone", () => {
    const out = extractPickups([
      ent("item_quad", "10 20 30"),
      // Present in map data but not implemented — must NOT become a pickup, or
      // players would grab an item that does nothing.
      ent("item_warshell", "0 0 0"),
      ent("item_regen", "0 0 0"),
    ]);
    expect(out.map((e) => `${e.type}:${e.kind}`)).toEqual(["powerup:quad"]);
    expect(out[0].position).toEqual({ x: 10, y: 30, z: 20 });
  });

  it("maps medium (25) and bare item_health to the medium kind", () => {
    const out = extractPickups([ent("item_health_medium", "0 0 0"), ent("item_health", "0 0 0")]);
    expect(out.map((e) => e.kind)).toEqual(["medium", "medium"]);
  });

  it("marks an item the map suspends (spawnflag 1), and no other", () => {
    const table = extractPickups([
      { classname: "item_quad", properties: { origin: "0 0 64", spawnflags: "1" } },
      { classname: "item_armor_ra", properties: { origin: "0 0 64", spawnflags: "4" } },
      { classname: "item_health_mega", properties: { origin: "0 0 64" } },
    ]);

    expect(table.map((entry) => entry.suspended)).toEqual([true, undefined, undefined]);
  });

  it("skips entities with missing or malformed origin", () => {
    const out = extractPickups([
      ent("weapon_rocketlauncher"),
      ent("item_health_mega", "nope"),
      ent("weapon_lasergun", "1 2 3"),
    ]);
    expect(out.map((e) => e.kind)).toEqual(["voltaic"]);
    expect(out[0].id).toBe(0);
  });

  it("is deterministic: identical input yields identical ids", () => {
    const entities: Ent[] = [
      ent("weapon_rocketlauncher", "100 200 16"),
      ent("ammo_rockets", "150 250 16"),
      ent("item_armor_ra", "500 600 16"),
      ent("weapon_rocketlauncher", "700 800 16"),
    ];
    const a = extractPickups(entities);
    const b = extractPickups(entities);
    expect(a).toEqual(b);
    expect(a[0].id).not.toBe(a[3].id);
  });
});

describe("extractWeaponPickups", () => {
  it("returns only weapons but keeps ids from the full pickup id space", () => {
    const weapons = extractWeaponPickups([
      ent("item_armor_ga", "0 0 0"),
      ent("ammo_rockets", "0 0 0"),
      ent("weapon_rocketlauncher", "1 1 1"),
    ]);
    expect(weapons).toHaveLength(1);
    expect(weapons[0].id).toBe(2);
    expect(weapons[0].kind).toBe("rlauncher");
  });
});

describe("PICKUP_CLASSNAMES", () => {
  it("includes every weapon classname and known ammo classnames", () => {
    for (const classname of Object.keys(CLASSNAME_TO_WEAPON)) {
      expect(PICKUP_CLASSNAMES[classname]?.type).toBe("weapon");
    }
    expect(PICKUP_CLASSNAMES.ammo_rockets).toMatchObject({ type: "ammo", kind: "rockets", amount: 10 });
  });
});

describe("map gametype keys", () => {
  const duel = { names: ["duel"], kind: "duel" } as const;
  const ffa = { names: ["dm", "ffa"], kind: "free" } as const;
  const snd = { names: ["bomb", "snd"], kind: "team" } as const;

  it("reads the gametype list and the not-keys, and nothing from an entity without them", () => {
    expect(mapModeKeys({ gametype: "Duel, tdm  ca" })).toEqual({ gametypes: ["duel", "tdm", "ca"] });
    expect(mapModeKeys({ notduel: "1", notteam: "0", notfree: "2" })).toEqual({ notDuel: true, notFree: true });
    expect(mapModeKeys({ origin: "0 0 0" })).toBeUndefined();
  });

  it("puts washoi_dm1's shared spot's megahealth in duels and its ultra health everywhere else", () => {
    const [mega, ultra] = extractPickups([
      { classname: "item_health_mega", properties: { origin: "-144 -720 -16", gametype: "duel" } },
      { classname: "item_health_ultra", properties: { origin: "-144 -720 -16", notduel: "1" } },
    ]);
    expect([spawnsIn(mega.modes, duel), spawnsIn(ultra.modes, duel)]).toEqual([true, false]);
    expect([spawnsIn(mega.modes, ffa), spawnsIn(ultra.modes, ffa)]).toEqual([false, true]);
    expect([spawnsIn(mega.modes, snd), spawnsIn(ultra.modes, snd)]).toEqual([false, true]);
  });

  it("leaves team-only exclusions to team modes", () => {
    const keys = mapModeKeys({ notteam: "1" });
    expect([spawnsIn(keys, duel), spawnsIn(keys, ffa), spawnsIn(keys, snd)]).toEqual([true, true, false]);
  });
});
