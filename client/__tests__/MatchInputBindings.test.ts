// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { type MatchInputActions, MatchInputBindings } from "../MatchInputBindings";

function actions(over: Partial<MatchInputActions> = {}): MatchInputActions {
  return {
    playerState: () => "spectator",
    isSpectatingTeammate: () => false,
    cycleTeammate: vi.fn(),
    nextSpectateTarget: vi.fn(),
    prevSpectateTarget: vi.fn(),
    isChasing: () => false,
    exitChaseCam: vi.fn(),
    isKeyDown: () => false,
    joinGame: vi.fn(),
    menuOpen: () => false,
    joinOverlayOpen: () => false,
    showScoreboard: vi.fn(),
    hideScoreboard: vi.fn(),
    ...over,
  };
}

const key = (type: "keydown" | "keyup", code: string) => {
  const event = new KeyboardEvent(type, { code, cancelable: true });
  document.dispatchEvent(event);
  return event;
};

const click = (button: number) => {
  const event = new MouseEvent("mousedown", { button, cancelable: true });
  document.dispatchEvent(event);
  return event;
};

const lockPointer = (locked: boolean) =>
  Object.defineProperty(document, "pointerLockElement", { value: locked ? document.body : null, configurable: true });

describe("MatchInputBindings", () => {
  const bindings = new MatchInputBindings();
  afterEach(() => {
    bindings.unbind();
    lockPointer(false);
  });

  it("cycles spectate targets with the arrows while spectating", () => {
    const a = actions();
    bindings.bind(document, a);
    expect(key("keydown", "ArrowRight").defaultPrevented).toBe(true);
    key("keydown", "ArrowLeft");
    expect(a.nextSpectateTarget).toHaveBeenCalledTimes(1);
    expect(a.prevSpectateTarget).toHaveBeenCalledTimes(1);
  });

  it("cycles teammates with the arrows when dead in a round, and ignores them when alive", () => {
    const dead = actions({ playerState: () => "playing", isSpectatingTeammate: () => true });
    bindings.bind(document, dead);
    key("keydown", "ArrowRight");
    key("keydown", "ArrowLeft");
    expect(dead.cycleTeammate).toHaveBeenNthCalledWith(1, 1);
    expect(dead.cycleTeammate).toHaveBeenNthCalledWith(2, -1);
    expect(dead.nextSpectateTarget).not.toHaveBeenCalled();

    const alive = actions({ playerState: () => "playing" });
    bindings.bind(document, alive);
    expect(key("keydown", "ArrowRight").defaultPrevented).toBe(false);
    expect(alive.cycleTeammate).not.toHaveBeenCalled();
  });

  it("returns to freefly on Space or Backspace only while chasing", () => {
    const freefly = actions();
    bindings.bind(document, freefly);
    expect(key("keydown", "Space").defaultPrevented).toBe(false);
    expect(freefly.exitChaseCam).not.toHaveBeenCalled();

    const chasing = actions({ isChasing: () => true });
    bindings.bind(document, chasing);
    key("keydown", "Space");
    key("keydown", "Backspace");
    expect(chasing.exitChaseCam).toHaveBeenCalledTimes(2);
  });

  it("chases on a left click only with the pointer locked and while spectating", () => {
    const a = actions();
    bindings.bind(document, a);
    click(0);
    expect(a.nextSpectateTarget).not.toHaveBeenCalled();
    lockPointer(true);
    click(1);
    expect(a.nextSpectateTarget).not.toHaveBeenCalled();
    expect(click(0).defaultPrevented).toBe(true);
    expect(a.nextSpectateTarget).toHaveBeenCalledTimes(1);

    const playing = actions({ playerState: () => "playing" });
    bindings.bind(document, playing);
    click(0);
    expect(playing.nextSpectateTarget).not.toHaveBeenCalled();
  });

  it("joins on J while spectating", () => {
    const held = new Set<string>();
    const a = actions({ isKeyDown: (code) => held.has(code) });
    bindings.bind(document, a);
    key("keydown", "KeyK");
    expect(a.joinGame).not.toHaveBeenCalled();
    held.add("KeyJ");
    key("keydown", "KeyJ");
    expect(a.joinGame).toHaveBeenCalledTimes(1);

    const playing = actions({ playerState: () => "playing", isKeyDown: () => true });
    bindings.bind(document, playing);
    key("keydown", "KeyJ");
    expect(playing.joinGame).not.toHaveBeenCalled();
  });

  it("shows the scoreboard while Tab is held, unless a menu or the join overlay has it", () => {
    const a = actions();
    bindings.bind(document, a);
    expect(key("keydown", "Tab").defaultPrevented).toBe(true);
    key("keyup", "Tab");
    expect(a.showScoreboard).toHaveBeenCalledTimes(1);
    expect(a.hideScoreboard).toHaveBeenCalledTimes(1);

    for (const blocked of [actions({ menuOpen: () => true }), actions({ joinOverlayOpen: () => true })]) {
      bindings.bind(document, blocked);
      expect(key("keydown", "Tab").defaultPrevented).toBe(false);
      expect(blocked.showScoreboard).not.toHaveBeenCalled();
    }
  });

  it("removes every listener on unbind, and rebinding does not stack them", () => {
    const first = actions();
    bindings.bind(document, first);
    const second = actions();
    bindings.bind(document, second);
    key("keydown", "ArrowRight");
    expect(first.nextSpectateTarget).not.toHaveBeenCalled();
    expect(second.nextSpectateTarget).toHaveBeenCalledTimes(1);

    bindings.unbind();
    expect(bindings.isBound()).toBe(false);
    lockPointer(true);
    key("keydown", "ArrowRight");
    key("keydown", "Tab");
    key("keyup", "Tab");
    click(0);
    expect(second.nextSpectateTarget).toHaveBeenCalledTimes(1);
    expect(second.showScoreboard).not.toHaveBeenCalled();
    expect(second.hideScoreboard).not.toHaveBeenCalled();
    bindings.unbind(); // a second unbind is harmless
  });
});
