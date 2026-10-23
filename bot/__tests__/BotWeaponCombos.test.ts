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
