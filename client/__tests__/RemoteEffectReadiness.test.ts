import { describe, expect, it, vi } from "vitest";

const teleport = vi.hoisted(() => vi.fn());
vi.mock("../TeleportEffect", () => ({ TeleportEffect: { getInstance: () => ({ playerTeleported: teleport }) } }));

import { RemotePlayerRenderer } from "../RemotePlayerRenderer";

function owner() {
  const renderer = Object.create(RemotePlayerRenderer.prototype) as {
    playTeleportEffect: (...args: unknown[]) => void;
    waitForPendingEffects: () => Promise<void>;
  };
  const state = {
    pendingEffects: new Set<Promise<void>>(),
    demoDiscontinuityId: 1,
    disposed: false,
    scene: {},
    resolveLegacyTeamColor: () => "alpha",
  };
  Object.assign(renderer, state);
  return { renderer, state };
}

describe("manual demo effect readiness", () => {
  it("completes a lazy teleport before the caller advances its frame clock", async () => {
    teleport.mockClear();
    const { renderer, state } = owner();
    renderer.playTeleportEffect({ smoothedPos: { x: 1, y: 2, z: 3 }, smoothedYaw: 0 }, "player_1", {
      x: 4,
      y: 5,
      z: 6,
      yaw: 1,
    });
    await renderer.waitForPendingEffects();
    expect(teleport).toHaveBeenCalledWith(state.scene, { x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }, 0, 1, "alpha");
    expect(state.pendingEffects.size).toBe(0);
  });

  it("does not spawn an effect after its playback owner is disposed", async () => {
    teleport.mockClear();
    const { renderer } = owner();
    renderer.playTeleportEffect({ smoothedPos: { x: 1, y: 2, z: 3 }, smoothedYaw: 0 }, "player_1", {
      x: 4,
      y: 5,
      z: 6,
      yaw: 1,
    });
    Object.assign(renderer, { disposed: true });
    await renderer.waitForPendingEffects();
    expect(teleport).not.toHaveBeenCalled();
  });
});
