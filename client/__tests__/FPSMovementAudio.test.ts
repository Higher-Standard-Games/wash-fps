import { beforeEach, describe, expect, it, vi } from "vitest";

const audio = {
  preloadSfx: vi.fn(async () => {}),
  playSfx2D: vi.fn(),
  playSfx3D: vi.fn(),
};
vi.mock("../../../../engine/AudioManager", () => ({
  AudioManager: { getInstance: () => audio },
}));

const ground = { texture: "textures/floor", surfaceFlags: 0 };
const collision = {
  isInitialized: () => true,
  getBsp: () => ({ textures: [{ name: ground.texture, surfaceFlags: ground.surfaceFlags }] }),
  trace: () => ({ hitTextureName: ground.texture }),
};
vi.mock("../../../../engine/physics/CollisionManager", () => ({
  getCollisionManager: () => collision,
}));

import type { GameState } from "../../../../engine/network/core/GameState";
import { SurfaceFlags } from "../../../../engine/physics/ContentFlags";
import { processFPSMovementAudio, resetFPSMovementAudio } from "../FPSMovementAudio";

function stateAt(x: number, grounded: boolean, velocityY = 0, entityId = "player_1"): GameState {
  const components = {
    transform: { position: { x, y: 32, z: 0 } },
    velocity: { grounded, linear: { x: grounded ? 220 : 100, y: velocityY, z: 0 } },
    movementState: { isSliding: false, isCrouching: false },
  };
  return {
    players: new Map([[entityId, { entityId }]]),
    entities: new Map([
      [
        entityId,
        {
          getComponent: (name: keyof typeof components) => components[name],
        },
      ],
    ]),
  } as unknown as GameState;
}

describe("FPSMovementAudio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ground.surfaceFlags = 0;
    resetFPSMovementAudio();
  });

  it("emits distance-driven local steps and chooses BSP metal variants", () => {
    ground.surfaceFlags = SurfaceFlags.METALSTEPS;
    processFPSMovementAudio(stateAt(0, true), "player_1");
    processFPSMovementAudio(stateAt(130, true), "player_1");

    expect(audio.playSfx2D).toHaveBeenCalledOnce();
    expect(audio.playSfx2D.mock.calls[0][0]).toMatch(/^sounds\/world\/ft_step_met[1-3]\.ogg$/);
  });

  it("suppresses steps on BSP NOSTEPS surfaces", () => {
    ground.surfaceFlags = SurfaceFlags.NOSTEPS;
    processFPSMovementAudio(stateAt(0, true), "player_1");
    processFPSMovementAudio(stateAt(130, true), "player_1");
    expect(audio.playSfx2D).not.toHaveBeenCalled();
    expect(audio.playSfx3D).not.toHaveBeenCalled();
  });

  it("plays Bobot jump edges at the player location", () => {
    processFPSMovementAudio(stateAt(0, true, 0, "player_2"), "player_1");
    processFPSMovementAudio(stateAt(20, false, 240, "player_2"), "player_1");

    expect(audio.playSfx3D).toHaveBeenCalledOnce();
    expect(audio.playSfx3D.mock.calls[0][0]).toMatch(/^sounds\/players\/bobot\/jump_[12]\.ogg$/);
    expect(audio.playSfx3D.mock.calls[0][1]).toEqual({ x: 20, y: 32, z: 0 });
  });
});
