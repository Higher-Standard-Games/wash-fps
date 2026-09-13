import type { Scene } from "@babylonjs/core/scene";
import { describe, expect, it, vi } from "vitest";
import { DroppedWeaponRenderer } from "../DroppedWeaponRenderer";

const loading = vi.hoisted(() => ({
  inventoryRequested: false,
  releaseInventory: () => {},
  getCamera: vi.fn(() => null),
}));

vi.mock("../../../../engine/camera/CameraSystem", () => ({
  CameraSystem: { getInstance: () => ({ getCamera: loading.getCamera }) },
}));
vi.mock("../../world/InventoryManager", async () => {
  loading.inventoryRequested = true;
  await new Promise<void>((resolve) => {
    loading.releaseInventory = resolve;
  });
  return { InventoryManager: { MAX_WEAPONS: 3 } };
});
vi.mock("../../world/PickupPrompt", () => ({ hidePickupPrompt: vi.fn(), showPickupPrompt: vi.fn() }));

// Exercise the awaited check directly so rejected fire-and-forget work is an assertion failure.
function check(renderer: DroppedWeaponRenderer): Promise<void> {
  return (renderer as unknown as { _checkPickupProximityAsync(): Promise<void> })._checkPickupProximityAsync();
}

describe("dropped weapon proximity module loading", () => {
  it("handles another snapshot while the camera is loaded but inventory is still pending", async () => {
    const renderer = new DroppedWeaponRenderer({} as Scene);
    const first = check(renderer);
    try {
      await vi.waitFor(() => expect(loading.inventoryRequested).toBe(true));
      await expect(check(renderer)).resolves.toBeUndefined();
      expect(loading.getCamera).not.toHaveBeenCalled();
    } finally {
      loading.releaseInventory();
      await first;
    }
    expect(loading.getCamera).toHaveBeenCalledTimes(1);
    await check(renderer);
    expect(loading.getCamera).toHaveBeenCalledTimes(2);
    renderer.dispose();
  });

  it("does not resume pickup checks after disposal during module loading", async () => {
    loading.getCamera.mockClear();
    const renderer = new DroppedWeaponRenderer({} as Scene);
    const pending = check(renderer);
    renderer.dispose();
    await pending;
    expect(loading.getCamera).not.toHaveBeenCalled();
  });
});
