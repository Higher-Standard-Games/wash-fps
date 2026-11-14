import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => ({
  updateRemoteLightningFallback: vi.fn(),
  updateRemoteLightningBeam: vi.fn(),
  updateLocalLightningTruth: vi.fn(),
}));
vi.mock("../../../../engine/weapon/HitscanEffects", () => ({ getHitscanEffects: () => fx }));
vi.mock("../../../../engine/weapon/ProjectileManager", () => ({ getProjectileManager: () => ({ isInitialized: () => true }) }));

import { handleRemoteWeaponFire, handleVoltaicBeam } from "../GameEvents";

const voltaicFire = {
  type: "weapon_fire",
  entityId: "player_3",
  weaponId: "voltaic",
  originX: 0,
  originY: 40,
  originZ: 0,
  dirX: 0,
  dirY: 0,
  dirZ: 1,
} as never;

describe("another player's Voltaic beam", () => {
  beforeEach(() => vi.clearAllMocks());

  it("takes its contact from the snapshot's voltaic_beam, without a scene ray pick of its own", () => {
    handleRemoteWeaponFire(voltaicFire, null, true);
    expect(fx.updateRemoteLightningFallback).not.toHaveBeenCalled();
  });

  it("still traces its own contact where no voltaic_beam came (packets, older demos)", () => {
    handleRemoteWeaponFire(voltaicFire, null);
    expect(fx.updateRemoteLightningFallback).toHaveBeenCalledOnce();
  });
});

const beamTruth = {
  type: "voltaic_beam" as const,
  entityId: "player_3",
  originX: 10,
  originY: 40,
  originZ: 20,
  dirX: 0,
  dirY: 0,
  dirZ: 1,
  endX: 10,
  endY: 40,
  endZ: 400,
  normalX: 0,
  normalY: 0,
  normalZ: -1,
  impactKind: 1 as const,
};

it("leaves the live local beam on its per-frame prediction when a server sample arrives", () => {
  handleVoltaicBeam(beamTruth, true);
  expect(fx.updateLocalLightningTruth).not.toHaveBeenCalled();
  expect(fx.updateRemoteLightningBeam).not.toHaveBeenCalled();
});

it("keeps remote and recorded beams on the exact server endpoint", () => {
  handleVoltaicBeam(beamTruth, false);
  expect(fx.updateRemoteLightningBeam).toHaveBeenCalledOnce();
  expect(fx.updateRemoteLightningBeam.mock.calls[0][1]).toMatchObject({
    origin: new Vector3(10, 40, 20),
    endpoint: new Vector3(10, 40, 400),
    impactKind: "world",
  });
});
