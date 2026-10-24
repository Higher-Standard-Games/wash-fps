// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { LobbyDownloadIndicator } from "../LobbyDownloadIndicator";

vi.mock("../../../../engine/loader/pk3/PackageStore", () => ({
  PackageStore: { shared: { paused: false, setPaused: vi.fn() } },
}));
vi.mock("../LobbyAssetPreparation", () => ({
  LobbyAssetPreparation: {
    shared: {
      selectMap: vi.fn(),
      retry: vi.fn(),
      status: () => ({ label: "Downloads ready", detail: "Common assets", packages: [] }),
    },
  },
}));

it("dismisses on outside presses, keeps inside controls open, and removes its document listener", () => {
  const indicator = new LobbyDownloadIndicator();
  document.body.append(indicator.root);
  try {
    indicator.root.open = true;
    indicator.root.querySelector("input")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(indicator.root.open).toBe(true);
    indicator.root.querySelector<HTMLButtonElement>('[aria-label="Close downloads"]')!.click();
    expect(indicator.root.open).toBe(false);
    indicator.root.open = true;
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(indicator.root.open).toBe(false);
    indicator.destroy();
    indicator.root.open = true;
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(indicator.root.open).toBe(true);
  } finally {
    indicator.destroy();
  }
});
