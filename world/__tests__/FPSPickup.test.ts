/**
 * FPSPickup static-API tests
 *
 * Targets the live static API on FPSPickup:
 *   - pickupById registry (keyed by authoritative server pickup id)
 *   - reconcileActiveSet(mask) — toggles each registered pickup's visibility to
 *     match the server's authoritative snapshot active-set (the convergent,
 *     self-healing replacement for the old item_pickup deactivation registry).
 *   - triggerUseAction (HUD prompt clearing)
 *
 * Constructing a real FPSPickup requires a Babylon Scene + async model loading,
 * which we can't spin up in vitest. Instead we inject fake-pickup-shaped objects
 * into the static registry via the `as any` escape hatch.
 *
 * See docs/research/SERVER_AUTHORITATIVE_PICKUPS.md.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { FPSPickup } from "../FPSPickup";

interface FakePickup {
  isActive: boolean;
  options: { id: string; pickupId?: number };
  setActiveState: ReturnType<typeof vi.fn>;
}

function makeFakePickup(id: string, pickupId: number): FakePickup {
  return {
    isActive: true,
    options: { id, pickupId },
    // Mirror Pickup.setActiveState's idempotent contract for assertions.
    setActiveState: vi.fn(function (this: FakePickup, active: boolean) {
      this.isActive = active;
    }),
  };
}

function resetRegistry() {
  // biome-ignore lint/suspicious/noExplicitAny: tests reach into private statics intentionally
  const P = FPSPickup as any;
  P.pickupById = new Map();
  P.nearbyWeaponPickup = null;
}

function register(p: FakePickup) {
  // biome-ignore lint/suspicious/noExplicitAny: tests reach into private statics intentionally
  (FPSPickup as any).pickupById.set(p.options.pickupId, p);
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

  it("maps mask index → pickup id (id is the bit index)", () => {
    const p = makeFakePickup("riotgun", 5);
    register(p);

    // Only index 5 is false; everything else true/absent.
    const mask = [true, true, true, true, true, false];
    FPSPickup.reconcileActiveSet(mask);

    expect(p.setActiveState).toHaveBeenCalledWith(false);
  });

  it("ignores ids with no registered pickup (still loading) without throwing", () => {
    const p = makeFakePickup("rlauncher", 1);
    register(p); // only id 1 registered; id 0 has no pickup yet

    expect(() => FPSPickup.reconcileActiveSet([false, true])).not.toThrow();
    expect(p.setActiveState).toHaveBeenCalledWith(true);
  });

  it("does nothing for an empty or missing mask", () => {
    const p = makeFakePickup("rlauncher", 0);
    register(p);

    FPSPickup.reconcileActiveSet([]);
    // biome-ignore lint/suspicious/noExplicitAny: exercising the nullish guard
    FPSPickup.reconcileActiveSet(undefined as any);

    expect(p.setActiveState).not.toHaveBeenCalled();
  });
});

describe("FPSPickup.triggerUseAction", () => {
  beforeEach(resetRegistry);

  it("clears the tracked nearby weapon prompt", () => {
    const p = makeFakePickup("rlauncher", 0);
    // biome-ignore lint/suspicious/noExplicitAny: set the private static for the test
    (FPSPickup as any).nearbyWeaponPickup = p;

    FPSPickup.triggerUseAction();

    // biome-ignore lint/suspicious/noExplicitAny: read the private static
    expect((FPSPickup as any).nearbyWeaponPickup).toBeNull();
  });

  it("is a no-op when nothing is nearby", () => {
    expect(() => FPSPickup.triggerUseAction()).not.toThrow();
  });
});
