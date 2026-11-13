/**
 * Joining a learned route's script on the run: the run-up is the script's
 * leading plain sprint, and a bot matching one of its states in place, speed
 * and heading may take over from there.
 */

import { describe, expect, it } from "vitest";
import type { RouteCommand } from "../LearnedRoutes";
import { findJoin, type RunUpState, runUpLength } from "../sequences/FlyingStart";

const run: RouteCommand = { forward: 1, right: 0, yaw: 0, pitch: 0, buttons: 64 };
const jump: RouteCommand = { ...run, buttons: 64 | 16 };

describe("runUpLength", () => {
  it("counts the leading plain sprint", () => {
    expect(runUpLength([run, run, run, jump, run])).toBe(3);
  });

  it("is zero for a script that starts with the trick or never leaves the run-up", () => {
    expect(runUpLength([jump, run])).toBe(0);
    expect(runUpLength([run, run])).toBe(0);
    expect(runUpLength([])).toBe(0);
  });
});

describe("findJoin", () => {
  // A run-up along +z, speeding up 40 u/s a tick, 4 units a tick.
  const runUp: RunUpState[] = Array.from({ length: 10 }, (_, k) => ({
    position: { x: 0, y: 0, z: 4 * (k + 1) },
    velocity: { x: 0, y: 0, z: 40 * (k + 1) },
  }));

  it("finds the state the bot matches in place, speed and heading", () => {
    expect(findJoin(runUp, { x: 2, y: 0, z: 21 }, { x: 0, y: 0, z: 210 })).toBe(4);
  });

  it("refuses a bot off the line, too slow, or running another way", () => {
    expect(findJoin(runUp, { x: 40, y: 0, z: 20 }, { x: 0, y: 0, z: 200 })).toBeNull();
    expect(findJoin(runUp, { x: 0, y: 0, z: 36 }, { x: 0, y: 0, z: 100 })).toBeNull();
    expect(findJoin(runUp, { x: 0, y: 0, z: 20 }, { x: 100, y: 0, z: 180 })).toBeNull();
    expect(findJoin(runUp, { x: 0, y: 0, z: 20 }, { x: 0, y: 0, z: 0 })).toBeNull();
  });
});
