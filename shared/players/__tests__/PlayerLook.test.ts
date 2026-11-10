import { describe, expect, it } from "vitest";
import { GameState, PlayerState } from "../../../../../engine/network/core/GameState";
import { BinaryProtocol } from "../../../../../engine/network/protocol/BinaryProtocol";
import { decodeLook, encodeLook, LOOK_COLORS, LOOK_MODELS, PlayerLooks } from "../PlayerLook";

function roster(look?: number): GameState {
  const state = new GameState();
  state.tick = 3;
  const player = new PlayerState();
  player.entityId = "player_1";
  player.name = "Player_1";
  player.team = "ffa";
  player.look = look;
  state.players.set("1", player);
  return state;
}

describe("free-for-all looks", () => {
  it("packs a model and a colour into one byte", () => {
    const look = encodeLook(LOOK_MODELS.indexOf("robot"), LOOK_COLORS.indexOf("lime"));
    expect(decodeLook(look)).toEqual({ model: "robot", color: "lime" });
    expect(decodeLook(encodeLook(15, 0))).toBeNull();
  });

  it("gives eight players eight colours and spreads the bodies evenly", () => {
    const looks = new PlayerLooks(() => 0.5);
    const ids = Array.from({ length: 8 }, (_, i) => `p${i}`);
    const bytes = looks.assign(ids);
    const colors = new Set([...bytes.values()].map((look) => decodeLook(look)!.color));
    expect(colors.size).toBe(8);
    const bodies = new Map<string, number>();
    for (const look of bytes.values()) {
      const model = decodeLook(look)!.model;
      bodies.set(model, (bodies.get(model) ?? 0) + 1);
    }
    expect(Math.max(...bodies.values()) - Math.min(...bodies.values())).toBeLessThanOrEqual(1);
  });

  it("keeps a player's look while they stay and frees it when they leave", () => {
    const looks = new PlayerLooks(() => 0);
    const first = looks.assign(["a", "b"]);
    expect(looks.assign(["a", "b"])).toEqual(first);
    // b leaves; the newcomer gets b's colour back, the least worn again
    const next = looks.assign(["a", "c"]);
    expect(next.get("a")).toBe(first.get("a"));
    expect(decodeLook(next.get("c")!)!.color).toBe(decodeLook(first.get("b")!)!.color);
  });

  it("carries the look in the player record, and reads a record without one", () => {
    const look = encodeLook(2, 5);
    const got = BinaryProtocol.decodeSnapshot(BinaryProtocol.encodeSnapshot(roster(look)));
    expect(got.players.get("1")?.look).toBe(look);
    const old = BinaryProtocol.decodeSnapshot(BinaryProtocol.encodeSnapshot(roster()));
    expect(old.players.get("1")?.look).toBeUndefined();
    expect(old.players.get("1")?.team).toBe("ffa");
  });
});
