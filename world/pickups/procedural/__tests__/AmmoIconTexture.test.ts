import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureIndex: vi.fn(async () => {}),
  findFile: vi.fn(),
  ensurePK3: vi.fn(async () => {}),
  resolveAndLoadTexture: vi.fn(),
  loadTexture: vi.fn(),
}));
vi.mock("../../../../../../engine/loader/pk3/PK3Index", () => ({ PK3Index: { getInstance: () => mocks } }));
vi.mock("../../../../../../engine/loader/pk3/PK3Loader", () => ({ PK3Loader: { getInstance: () => mocks } }));
vi.mock("../../../../../../engine/loader/pk3/PK3TextureLoader", () => ({
  PK3TextureLoader: { getInstance: () => mocks },
}));

import { loadAmmoIconTexture } from "../../AmmoIconTexture";

beforeEach(() => vi.resetAllMocks());
describe("ammo artwork package loading", () => {
  it("loads the indexed owner before resolving the icon, without a loose request", async () => {
    const texture = {};
    mocks.findFile.mockReturnValue("washoi_gfx.pk3");
    mocks.resolveAndLoadTexture.mockImplementation(async () => {
      expect(mocks.ensurePK3).toHaveBeenCalledWith("washoi_gfx.pk3");
      return texture;
    });
    expect(await loadAmmoIconTexture("gfx/hud/icons/ammo/bulletsammo")).toBe(texture);
    expect(mocks.findFile).toHaveBeenCalledWith("gfx/hud/icons/ammo/bulletsammo.tga");
    expect(mocks.ensureIndex).toHaveBeenCalledOnce();
    expect(mocks.loadTexture).not.toHaveBeenCalled();
  });
  it("retains the loose TGA fallback for custom media without an indexed icon", async () => {
    mocks.resolveAndLoadTexture.mockResolvedValue(null);
    mocks.loadTexture.mockResolvedValue(null);
    expect(await loadAmmoIconTexture("gfx/custom/ammo")).toBeNull();
    expect(mocks.ensurePK3).not.toHaveBeenCalled();
    expect(mocks.loadTexture).toHaveBeenCalledWith("gfx/custom/ammo.tga");
  });
});
