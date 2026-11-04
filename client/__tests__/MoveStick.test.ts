import { describe, expect, it, vi } from "vitest";
import { Game, type PlayerInputState } from "../../Game";
import { STICK_DEAD_ZONE, stickDirection, stickKeys } from "../MoveStick";

const at = (degrees: number, length = 1) => ({
  forward: Math.cos((degrees * Math.PI) / 180) * length,
  right: Math.sin((degrees * Math.PI) / 180) * length,
});

describe("move stick", () => {
  it("reads as centred inside the dead zone and full length outside it", () => {
    expect(stickDirection(at(40, STICK_DEAD_ZONE * 0.9))).toBeNull();
    expect(stickDirection(null)).toBeNull();
    const half = stickDirection(at(40, 0.5));
    expect(Math.hypot(half?.forward ?? 0, half?.right ?? 0)).toBeCloseTo(1);
    expect(stickKeys(at(0, 0.05))).toEqual({ forward: false, backward: false, left: false, right: false });
  });

  it("splits the circle into eight sectors, as one or two keys do", () => {
    // Up to 22.5° off straight ahead is forward alone, which can run
    expect(stickKeys(at(20))).toEqual({ forward: true, backward: false, left: false, right: false });
    expect(stickKeys(at(-20))).toEqual({ forward: true, backward: false, left: false, right: false });
    expect(stickKeys(at(45))).toEqual({ forward: true, backward: false, left: false, right: true });
    expect(stickKeys(at(90))).toEqual({ forward: false, backward: false, left: false, right: true });
    expect(stickKeys(at(-135))).toEqual({ forward: false, backward: true, left: true, right: false });
    expect(stickKeys(at(180))).toEqual({ forward: false, backward: true, left: false, right: false });
  });
});

describe("Game.sendInput with a move stick", () => {
  function sentDirection(input: Partial<PlayerInputState>) {
    const sendCommand = vi.fn();
    const game = Object.assign(Object.create(Game.prototype), {
      isRunning: true,
      isNetworkMode: false,
      playerState: "playing",
      localPlayerId: "p1",
      commandSeq: 0,
      gameHost: { isConnected: () => true, sendCommand, currentTick: 0 },
      v2Client: null,
    }) as Game;
    game.sendInput({ pitch: 0, yaw: 0, weaponSlot: 0, ...input } as PlayerInputState);
    return sendCommand.mock.calls[0]?.[0]?.direction as { x: number; z: number };
  }

  it("moves at the stick's own angle rather than the nearest of eight", () => {
    const dir = sentDirection({ forward: true, right: true, moveAxis: at(30) });
    expect(dir.x).toBeCloseTo(Math.sin(Math.PI / 6));
    expect(dir.z).toBeCloseTo(Math.cos(Math.PI / 6));
  });

  it("moves along the keys without a stick", () => {
    const dir = sentDirection({ forward: true, right: true });
    expect(dir.x).toBeCloseTo(Math.SQRT1_2);
    expect(dir.z).toBeCloseTo(Math.SQRT1_2);
  });
});
