/**
 * FPSPickup static-API tests.
 *
 * Real FPSPickup construction needs a Babylon scene, so these tests inject
 * fake-pickup-shaped objects into the private static registries.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { FPSPickup } from "../FPSPickup";

interface FakePickup {
  isActive: boolean;
  options: { id: string; pickupId?: number; serverManagedRespawn?: boolean; entityId?: string; type?: string };
  position: { x: number; y: number; z: number };
  mesh?: { isEnabled: () => boolean };
  describeModelForAudit?: () => string;
  setActiveState: ReturnType<typeof vi.fn>;
}

function makeFakePickup(id: string, pickupId: number | undefined, extra: Partial<FakePickup> = {}): FakePickup {
  const { options, ...rest } = extra;
  return {
    isActive: true,
    position: { x: 0, y: 0, z: 0 },
    setActiveState: vi.fn(function (this: FakePickup, active: boolean) {
      this.isActive = active;
    }),
    ...rest,
    options: { id, pickupId, ...options },
  };
}

function resetRegistry() {
  const P = FPSPickup as unknown as {
    pickupById: Map<number, FakePickup>;
    allPickups: Set<FakePickup>;
    latestMask: boolean[];
    nearbyWeaponPickup: FakePickup | null;
  };
  P.pickupById = new Map();
  P.allPickups = new Set();
  P.latestMask = [];
  P.nearbyWeaponPickup = null;
}

function register(p: FakePickup) {
  const P = FPSPickup as unknown as {
    pickupById: Map<number, FakePickup>;
    allPickups: Set<FakePickup>;
  };
  P.allPickups.add(p);
  if (p.options.pickupId !== undefined) P.pickupById.set(p.options.pickupId, p);
}

describe("FPSPickup.reconcileActiveSet", () => {
  beforeEach(resetRegistry);

  it("toggles each registered pickup to its bit in the active-set", () => {
    const a = makeFakePickup("rlauncher", 0);
    const b = makeFakePickup("plasmagun", 1);
    const c = makeFakePickup("electrobolt", 2);
    register(a);
    register(b);
    register(c);

    FPSPickup.reconcileActiveSet([true, false, true]);

    expect(a.setActiveState).toHaveBeenCalledWith(true);
    expect(b.setActiveState).toHaveBeenCalledWith(false);
    expect(c.setActiveState).toHaveBeenCalledWith(true);
    expect(b.isActive).toBe(false);
  });

  it("maps mask index to pickup id", () => {
    const p = makeFakePickup("riotgun", 5);
    register(p);

    FPSPickup.reconcileActiveSet([true, true, true, true, true, false]);

    expect(p.setActiveState).toHaveBeenCalledWith(false);
  });

  it("ignores ids with no registered pickup without throwing", () => {
    const p = makeFakePickup("rlauncher", 1);
    register(p);

    expect(() => FPSPickup.reconcileActiveSet([false, true])).not.toThrow();
    expect(p.setActiveState).toHaveBeenCalledWith(true);
  });

  it("does nothing for an empty or missing mask", () => {
    const p = makeFakePickup("rlauncher", 0);
    register(p);

    FPSPickup.reconcileActiveSet([]);
    FPSPickup.reconcileActiveSet(undefined as never);

    expect(p.setActiveState).not.toHaveBeenCalled();
  });
});

describe("FPSPickup.auditActiveSet", () => {
  beforeEach(resetRegistry);

  it("reports clean when all mask ids have matching client pickups", () => {
    register(makeFakePickup("rlauncher", 0));

    const report = FPSPickup.auditActiveSet([true]);

    expect(report).toContain("pickup_audit: clean");
  });

  it("reports authoritative mask bits without client pickups", () => {
    const report = FPSPickup.auditActiveSet([true]);

    expect(report).toContain("mask ids without client pickup: 0");
  });

  it("reports server-managed map pickups that have no pickupId", () => {
    register(
      makeFakePickup("ammo_rockets", undefined, {
        options: { id: "ammo_rockets", serverManagedRespawn: true },
      }),
    );

    const report = FPSPickup.auditActiveSet([]);

    expect(report).toContain("server-managed pickups without pickupId");
    expect(report).toContain("ammo_rockets#none");
  });

  it("reports active/mesh mismatches", () => {
    register(makeFakePickup("rlauncher", 0, { isActive: true, mesh: { isEnabled: () => false } }));

    const report = FPSPickup.auditActiveSet([true]);

    expect(report).toContain("active/mesh mismatches");
    expect(report).toContain("rlauncher#0");
  });

  it("includes model render diagnostics when the pickup exposes them", () => {
    register(
      makeFakePickup("rlauncher", 0, {
        options: { id: "rlauncher", pickupId: 0, type: "weapon" },
        describeModelForAudit: () => "source=cache-flat,det(-/+0)=5/0/0",
      }),
    );

    const report = FPSPickup.auditActiveSet([true]);

    expect(report).toContain("source=cache-flat");
    expect(report).toContain("det(-/+0)=5/0/0");
  });
});

describe("FPSPickup.triggerUseAction", () => {
  beforeEach(resetRegistry);

  it("clears the tracked nearby weapon prompt", () => {
    const p = makeFakePickup("rlauncher", 0);
    (FPSPickup as unknown as { nearbyWeaponPickup: FakePickup | null }).nearbyWeaponPickup = p;

    FPSPickup.triggerUseAction();

    expect((FPSPickup as unknown as { nearbyWeaponPickup: FakePickup | null }).nearbyWeaponPickup).toBeNull();
  });

  it("is a no-op when nothing is nearby", () => {
    expect(() => FPSPickup.triggerUseAction()).not.toThrow();
  });
});
