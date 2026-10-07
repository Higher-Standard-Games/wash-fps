import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameState } from "../../../../engine/network/core/GameState";
import { MatchStateManager } from "../MatchStateManager";
import { PlayerWeaponStates, storeSnapshotState } from "../SnapshotStateStore";

function weaponState(entityId: string, currentWeapon: string) {
  return {
    type: "weapon_state",
    entityId,
    currentWeapon,
    weapons: ["blade", currentWeapon],
    ammo: { [currentWeapon]: { clip: 10, reserve: 40 } },
    reloading: false,
    lastFireTick: 5,
  };
}

function snapshot(events: unknown[]): GameState {
  return { events } as unknown as GameState;
}

describe("storeSnapshotState", () => {
  afterEach(() => {
    MatchStateManager.destroy();
    vi.restoreAllMocks();
  });

  it("stores every player's weapon state and the match state", () => {
    const weapons = new PlayerWeaponStates();
    const enemyWeapons = new Map<string, string>();
    storeSnapshotState(
      snapshot([
        weaponState("player_1", "machinegun"),
        weaponState("player_2", "riotgun"),
        { type: "match_state", phase: 2, timeRemaining: 30, standings: [], spectators: [] },
      ]),
      { weapons, enemyWeapons, localEntityId: "player_1" },
    );
    expect(weapons.get("player_1")?.currentWeapon).toBe("machinegun");
    expect(weapons.get("player_2")?.ammo).toEqual({ riotgun: { clip: 10, reserve: 40 } });
    expect(MatchStateManager.getInstance().timeRemaining).toBe(30);
  });

  it("puts only other players' weapons in enemyWeapons", () => {
    const enemyWeapons = new Map<string, string>();
    storeSnapshotState(snapshot([weaponState("player_1", "machinegun"), weaponState("player_2", "riotgun")]), {
      weapons: new PlayerWeaponStates(),
      enemyWeapons,
      localEntityId: "player_1",
    });
    expect([...enemyWeapons]).toEqual([["player_2", "riotgun"]]);
  });

  it("keeps storing after one event fails, and does not throw", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(MatchStateManager.getInstance(), "processEvent").mockImplementation(() => {
      throw new Error("boom");
    });
    const weapons = new PlayerWeaponStates();
    expect(() =>
      storeSnapshotState(snapshot([{ type: "match_state", phase: 2 }, weaponState("player_2", "riotgun")]), {
        weapons,
        enemyWeapons: new Map(),
        localEntityId: undefined,
      }),
    ).not.toThrow();
    expect(weapons.get("player_2")?.currentWeapon).toBe("riotgun");
  });

  it("forgets everything on clear, as on a new connection", () => {
    const weapons = new PlayerWeaponStates();
    storeSnapshotState(snapshot([weaponState("player_2", "riotgun")]), {
      weapons,
      enemyWeapons: new Map(),
      localEntityId: undefined,
    });
    weapons.clear();
    expect(weapons.get("player_2")).toBeUndefined();
  });
});
