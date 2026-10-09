// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { Game } from "../../Game";

/**
 * The event layer and Game read the same weapon, not two copies of it.
 *
 * The event context once took `_lastServerWeapon` by value. Snapshots updated
 * the context's copy and Game's own field stayed empty, so everything reading
 * Game — the crosshair, the empty click, the hip-fire aim — saw the blade.
 */
interface ContextGame {
  getEventContext(): { _lastServerWeapon: string | undefined; _localCharging: boolean };
  getCurrentWeaponId(): string;
}

const statics = Game as unknown as { instance: Game | null };

function game(): ContextGame {
  const instance = Object.assign(Object.create(Game.prototype), {
    _lastServerWeapon: undefined,
    _localCharging: false,
    enemyWeapons: new Map(),
    chargingPlayers: new Set(),
    chargingGlows: new Map(),
    projectiles: { defIds: new Map(), active: new Set(), buffer: {} },
    effects: { gibSystem: null, pendingGibSpawns: [], ragdollSystem: null, cartoonHit: null },
    spectate: { _deathCamera: {}, _followedWeapon: {} },
    onStateUpdateCallbacks: [],
  });
  statics.instance = instance;
  return instance as ContextGame;
}

afterEach(() => {
  statics.instance = null;
});

describe("the weapon the event layer records", () => {
  it("is the weapon the game reports", () => {
    const g = game();
    expect(g.getCurrentWeaponId()).toBe("blade");

    g.getEventContext()._lastServerWeapon = "rlauncher";

    expect(g.getCurrentWeaponId()).toBe("rlauncher");
  });

  it("stays shared after the context was first built", () => {
    const g = game();
    const ctx = g.getEventContext();
    ctx._lastServerWeapon = "plasmagun";
    ctx._localCharging = true;

    const again = g.getEventContext();
    expect(again._lastServerWeapon).toBe("plasmagun");
    expect(again._localCharging).toBe(true);
    expect(g.getCurrentWeaponId()).toBe("plasmagun");
  });
});
