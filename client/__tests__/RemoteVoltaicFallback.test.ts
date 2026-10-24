import { beforeEach, describe, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => ({ updateRemoteLightningFallback: vi.fn() }));
vi.mock("../../../../engine/weapon/HitscanEffects", () => ({ getHitscanEffects: () => fx }));
vi.mock("../../../../engine/weapon/ProjectileManager", () => ({ getProjectileManager: () => ({ scene: {} }) }));

import { handleRemoteWeaponFire } from "../GameEvents";

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
  beforeEach(() => fx.updateRemoteLightningFallback.mockClear());

  it("takes its contact from the snapshot's voltaic_beam, without a scene ray pick of its own", () => {
    handleRemoteWeaponFire(voltaicFire, null, true);
    expect(fx.updateRemoteLightningFallback).not.toHaveBeenCalled();
  });

  it("still traces its own contact where no voltaic_beam came (packets, older demos)", () => {
    handleRemoteWeaponFire(voltaicFire, null);
    expect(fx.updateRemoteLightningFallback).toHaveBeenCalledOnce();
  });
});
