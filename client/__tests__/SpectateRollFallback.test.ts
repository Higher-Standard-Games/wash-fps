import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { describe, expect, it, vi } from "vitest";
import { Game } from "../../Game";

interface CameraTarget {
  position: Vector3;
  rotation: Vector3;
  setTarget(target: Vector3): void;
}

interface CameraOwnershipGame {
  _isPlayerDead: boolean;
  _spectatingEntityId: string | null;
  _eyeCamera: { update: (dt: number, camera: unknown) => boolean };
  _deathCamera: { update: (dt: number, camera: unknown) => boolean };
  updateRoundEndCamera(): void;
  applyDeathCamera(camera: CameraTarget, dt: number): boolean;
}

function gameWithDrySpectateCamera(): CameraOwnershipGame {
  const game = Object.create(Game.prototype) as CameraOwnershipGame;
  game._isPlayerDead = true;
  game._spectatingEntityId = "player_bot";
  game._eyeCamera = { update: vi.fn(() => false) };
  game._deathCamera = { update: vi.fn(() => false) };
  game.updateRoundEndCamera = vi.fn();
  return game;
}

describe("teammate spectate roll fallback", () => {
  it("claims and levels a bot spectate frame even before round metadata arrives", () => {
    const game = gameWithDrySpectateCamera();
    const camera: CameraTarget = {
      position: Vector3.Zero(),
      rotation: new Vector3(0, 0, 0.7),
      setTarget: vi.fn(),
    };

    expect(game.applyDeathCamera(camera, 1 / 60)).toBe(true);
    expect(camera.rotation.z).toBe(0);
  });
});
