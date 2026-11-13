/**
 * Weapon combos: a rocket that throws the enemy up is followed by the
 * electrobolt at range or the riotgun close, a rocket at arm's length by the
 * blade, and long plasma pressure is broken by a rail shot.
 */

import { describe, expect, it } from "vitest";
import { BotGameState, type VisiblePlayer } from "../BotGameState";
import { BotWeaponCombos, slotFor } from "../BotWeaponCombos";

function scene(distance: number, rising = 0) {
  const state = new BotGameState();
  state.tick = 100;
  state.self.weapons = ["blade", "riotgun", "rlauncher", "plasmagun", "electrobolt"];
  state.self.ammo = { riotgun: 10, rlauncher: 10, plasmagun: 50, electrobolt: 5 };
  state.self.currentWeapon = "rlauncher";
  const enemy: VisiblePlayer = {
    entityId: "e",
    playerId: "foe",
    position: { x: 0, y: 0, z: distance },
    velocity: { x: 0, y: rising, z: 0 },
    isDead: false,
    team: "",
    relation: "enemy",
    distance,
  };
  const hit = (weaponId = "rlauncher") =>
    state.recentHits.push({ victimEntityId: "e", weaponId, damage: 80, tick: state.tick });
  return { state, enemy, hit };
}

const always = () => 0;

describe("rocket combos", () => {
  it("follows a launching rocket with the electrobolt at range", () => {
    const { state, enemy, hit } = scene(600, 400);
    const combos = new BotWeaponCombos(always);
    hit();
    expect(combos.choose(state, enemy, 0.9, "rlauncher")).toBe("electrobolt");
    expect(slotFor(state, "electrobolt")).toBe(5);
    // Held for a moment, then back to the distance pick
    state.tick += 50;
    expect(combos.choose(state, enemy, 0.9, "rlauncher")).toBe("electrobolt");
    state.tick += 100;
    expect(combos.choose(state, enemy, 0.9, "rlauncher")).toBeNull();
  });

  it("uses the riotgun on a launched enemy close by, and the blade at arm's length", () => {
    const close = scene(250, 400);
    close.hit();
    expect(new BotWeaponCombos(always).choose(close.state, close.enemy, 0.9, "rlauncher")).toBe("riotgun");

    const face = scene(120);
    face.hit();
    expect(new BotWeaponCombos(always).choose(face.state, face.enemy, 0.9, "rlauncher")).toBe("blade");
  });

  it("does nothing for a rocket that did not lift them, or other weapons' hits", () => {
    const flat = scene(600, 0);
    flat.hit();
    expect(new BotWeaponCombos(always).choose(flat.state, flat.enemy, 0.9, "rlauncher")).toBeNull();
    const mg = scene(600, 400);
    mg.hit("machinegun");
    expect(new BotWeaponCombos(always).choose(mg.state, mg.enemy, 0.9, "rlauncher")).toBeNull();
  });

  it("misses the chance at low prediction skill", () => {
    const { state, enemy, hit } = scene(600, 400);
    hit();
    expect(new BotWeaponCombos(() => 0.5).choose(state, enemy, 0.2, "rlauncher")).toBeNull();
  });
});

describe("plasma into rail", () => {
  it("breaks long plasma pressure at range with a rail shot", () => {
    const { state, enemy } = scene(700);
    state.self.currentWeapon = "plasmagun";
    const combos = new BotWeaponCombos(always);
    expect(combos.choose(state, enemy, 0.9, "plasmagun")).toBeNull();
    state.tick += 200;
    expect(combos.choose(state, enemy, 0.9, "plasmagun")).toBe("electrobolt");
    expect(combos.active).toBe("rail");
  });
});

describe("swap while reloading", () => {
  /** A bot carrying two guns, as the server allows, plus the blade. */
  function carrying(weapons: string[], current: string, distance: number) {
    const s = scene(distance);
    s.state.self.weapons = ["blade", ...weapons];
    s.state.self.ammo = { machinegun: 50, riotgun: 10, rlauncher: 10, plasmagun: 50, electrobolt: 5 };
    s.state.self.currentWeapon = current;
    return s;
  }

  it("follows a bolt with the machinegun, held until the bolt is ready again", () => {
    const { state, enemy } = carrying(["electrobolt", "machinegun"], "electrobolt", 700);
    const combos = new BotWeaponCombos(always);
    state.lastOwnShot = { weaponId: "electrobolt", tick: state.tick };
    expect(combos.choose(state, enemy, 0.9, "electrobolt")).toBe("machinegun");
    expect(combos.active).toBe("refire");
    state.tick += 100;
    expect(combos.choose(state, enemy, 0.9, "electrobolt")).toBe("machinegun");
    // The bolt refires 156 ticks after its shot: back to it then
    state.tick += 60;
    expect(combos.choose(state, enemy, 0.9, "electrobolt")).toBeNull();
  });

  it("follows a rocket with the riotgun close", () => {
    const { state, enemy } = carrying(["rlauncher", "riotgun"], "rlauncher", 300);
    state.lastOwnShot = { weaponId: "rlauncher", tick: state.tick };
    // The rocket refires in 100 ticks and the riotgun too: no gain, no swap.
    expect(new BotWeaponCombos(always).choose(state, enemy, 0.9, "rlauncher")).toBeNull();

    const bolt = carrying(["electrobolt", "riotgun"], "electrobolt", 400);
    bolt.state.lastOwnShot = { weaponId: "electrobolt", tick: bolt.state.tick };
    expect(new BotWeaponCombos(always).choose(bolt.state, bolt.enemy, 0.9, "electrobolt")).toBe("riotgun");
  });

  it("keeps the gun when the other one does not fit the distance", () => {
    const { state, enemy } = carrying(["electrobolt", "riotgun"], "electrobolt", 2000);
    state.lastOwnShot = { weaponId: "electrobolt", tick: state.tick };
    expect(new BotWeaponCombos(always).choose(state, enemy, 0.9, "electrobolt")).toBeNull();
  });

  it("rolls once per shot, at prediction-skill odds", () => {
    const { state, enemy } = carrying(["electrobolt", "machinegun"], "electrobolt", 700);
    const combos = new BotWeaponCombos(() => 0.5);
    state.lastOwnShot = { weaponId: "electrobolt", tick: state.tick };
    expect(combos.choose(state, enemy, 0.2, "electrobolt")).toBeNull();
    // Same shot, better odds: not rolled again
    expect(combos.choose(state, enemy, 0.9, "electrobolt")).toBeNull();
  });
});

describe("finishing an enemy the bot knows is low", () => {
  it("takes the hitscan gun whose one hit kills, at its distance", () => {
    const { state, enemy } = scene(700);
    const combos = new BotWeaponCombos(always);
    expect(combos.choose(state, enemy, 0.9, "rlauncher", { health: 30, armor: 0, uncertainty: 0 })).toBe("electrobolt");
  });

  it("does not act on an unsure or a healthy estimate", () => {
    const { state, enemy } = scene(700);
    expect(
      new BotWeaponCombos(always).choose(state, enemy, 0.9, "rlauncher", { health: 30, armor: 0, uncertainty: 0.6 }),
    ).toBeNull();
    expect(
      new BotWeaponCombos(always).choose(state, enemy, 0.9, "rlauncher", { health: 100, armor: 100, uncertainty: 0 }),
    ).toBeNull();
  });

  it("counts the armor in the way", () => {
    // Enough health to survive what gets past 100 armor, though not the whole hit.
    const { state, enemy } = scene(700);
    const combos = new BotWeaponCombos(always);
    expect(combos.choose(state, enemy, 0.9, "rlauncher", { health: 40, armor: 100, uncertainty: 0 })).toBeNull();
  });
});
