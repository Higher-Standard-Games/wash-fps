import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Cvar } from "../../../../engine/core/Cvar";
import { HitSpatter } from "../HitSpatter";

type Inside = {
  pieces: Array<{ alive: boolean; shade: number; splats: boolean }>;
  splats: Array<{ alive: boolean }>;
  floorUnder: () => number;
};

let scene: Scene;
let spatter: HitSpatter;
const inside = () => spatter as unknown as Inside;
const alive = () => inside().pieces.filter((piece) => piece.alive);
const at = { x: 0, y: 100, z: 0 };

beforeEach(() => {
  scene = new Scene(new NullEngine());
  spatter = HitSpatter.getInstance();
  spatter.init(scene);
  Cvar.set("cl_blood_splats", 1);
});

afterEach(() => {
  spatter.dispose();
  scene.dispose();
});

describe("hit spatter", () => {
  it("sprays more for a harder hit, and more again for a headshot", () => {
    spatter.spawn(at, "body", 10, { x: 1, z: 0 }, false);
    const light = alive().length;
    spatter.clear();
    spatter.spawn(at, "body", 50, { x: 1, z: 0 }, false);
    const hard = alive().length;
    spatter.clear();
    spatter.spawn(at, "head", 50, { x: 1, z: 0 }, false);
    expect(hard).toBeGreaterThan(light);
    expect(alive().length).toBeGreaterThan(hard);
  });

  it("bleeds from a person and sparks from a robot", () => {
    spatter.spawn(at, "body", 20, null, false);
    expect(alive().every((piece) => piece.shade <= 1)).toBe(true);
    spatter.clear();
    spatter.spawn(at, "body", 20, null, true);
    expect(alive().every((piece) => piece.shade >= 2)).toBe(true);
    // Sparks leave no marks
    expect(alive().some((piece) => piece.splats)).toBe(false);
  });

  it("splats blood where it lands, and not with the splats turned off", () => {
    inside().floorUnder = () => 76;
    spatter.spawn(at, "legs", 40, { x: 1, z: 0 }, false);
    for (let i = 0; i < 60; i++) spatter.update(1 / 60);
    expect(inside().splats.filter((splat) => splat.alive).length).toBeGreaterThan(0);
    // Nothing falls through the floor
    expect(alive().length).toBe(0);

    spatter.clear();
    Cvar.set("cl_blood_splats", 0);
    spatter.spawn(at, "legs", 40, { x: 1, z: 0 }, false);
    expect(alive().some((piece) => piece.splats)).toBe(false);
  });

  it("never keeps more pieces than its cap, and they are gone within a second", () => {
    for (let i = 0; i < 100; i++) spatter.spawn(at, "head", 100, null, false);
    expect(inside().pieces.length).toBeLessThanOrEqual(256);
    for (let i = 0; i < 60; i++) spatter.update(1 / 60);
    expect(alive().length).toBe(0);
  });
});
