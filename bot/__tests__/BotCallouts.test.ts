import { describe, expect, it } from "vitest";
import type { MapLocation } from "../../../../shared/bsp/LocationTable";
import { BotCallouts, type CalloutView, parseCallout, placePosition } from "../BotCallouts";

const locations: MapLocation[] = [
  { name: "Old Town", position: { x: 0, y: 0, z: 0 } },
  { name: "Station", position: { x: 2000, y: 0, z: 0 } },
  { name: "Station", position: { x: 2200, y: 0, z: 0 } },
];

function view(over: Partial<CalloutView>): CalloutView {
  return { nowMs: 10_000, team: "udon", locations, enemies: [], ...over };
}

describe("bot callouts", () => {
  it("calls the place with the most enemies in sight, and reads its own lines back", () => {
    const callouts = new BotCallouts();
    const line = callouts.observe(
      view({
        enemies: [
          { entityId: "player_2", position: { x: 2100, y: 0, z: 0 } },
          { entityId: "player_3", position: { x: 2050, y: 0, z: 0 } },
          { entityId: "player_4", position: { x: 10, y: 0, z: 0 } },
        ],
      }),
    );
    expect(line).toBe("/say_team 2 enemies at Station");
    expect(parseCallout("[TEAM] 2 enemies at Station")).toEqual({ kind: "enemies", count: 2, place: "Station" });
    expect(parseCallout("Enemy at Old Town")).toEqual({ kind: "enemies", count: 1, place: "Old Town" });
    expect(parseCallout("gl hf")).toBeNull();
  });

  it("calls the carrier first, a drop once, and keeps quiet about what a teammate just said", () => {
    const callouts = new BotCallouts(() => 0);
    const carried = { phase: "carried", position: { x: 0, y: 0, z: 0 }, carrier: "player_2", site: null };
    expect(
      callouts.observe(
        view({ objective: carried, enemies: [{ entityId: "player_2", position: { x: 5, y: 0, z: 0 } }] }),
      ),
    ).toBe("/say_team Bomb carrier at Old Town");
    // The carrier falls at the station while the bot is still in its quiet gap: the news waits.
    const dropped = { phase: "dropped", position: { x: 2100, y: 0, z: 0 }, carrier: null, site: null };
    expect(callouts.observe(view({ nowMs: 11_000, objective: dropped }))).toBeNull();
    expect(callouts.observe(view({ nowMs: 13_500, objective: dropped }))).toBe("/say_team Bomb dropped at Station");

    const other = new BotCallouts();
    other.heard("[TEAM] Enemy at Station", 20_000);
    const seen = { enemies: [{ entityId: "player_3", position: { x: 2100, y: 0, z: 0 } }] };
    expect(other.observe(view({ nowMs: 21_500, ...seen }))).toBeNull();
    expect(other.observe(view({ nowMs: 29_000, ...seen }))).toBe("/say_team Enemy at Station");
  });

  it("drops its news when a teammate says it first", () => {
    const callouts = new BotCallouts(() => 1);
    const carried = { phase: "carried", position: { x: 0, y: 0, z: 0 }, carrier: null, site: null };
    const dropped = { phase: "dropped", position: { x: 2100, y: 0, z: 0 }, carrier: null, site: null };
    callouts.observe(view({ nowMs: 1000, objective: carried }));
    expect(callouts.observe(view({ nowMs: 5000, objective: dropped }))).toBeNull();
    callouts.heard("[TEAM] Bomb dropped at Station", 5500);
    expect(callouts.observe(view({ nowMs: 8000, objective: dropped }))).toBeNull();
  });

  it("says nothing outside a team mode or on a map without places", () => {
    const enemies = [{ entityId: "player_2", position: { x: 0, y: 0, z: 0 } }];
    expect(new BotCallouts().observe(view({ team: null, enemies }))).toBeNull();
    expect(new BotCallouts().observe(view({ locations: [], enemies }))).toBeNull();
  });

  it("places a call at the middle of the locations with that name", () => {
    expect(placePosition(locations, "Station")).toEqual({ x: 2100, y: 0, z: 0 });
    expect(placePosition(locations, "Nowhere")).toBeNull();
  });
});
