import JSZip from "jszip";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  ensureIndex: vi.fn(async () => true),
  paused: false,
}));
vi.mock("../../../../engine/loader/pk3/PackageStore", () => ({
  PackageStore: {
    shared: { acquire: mocks.acquire, dropQueuedBackground: vi.fn(), paused: false, setPaused: vi.fn() },
  },
}));
vi.mock("../../../../engine/loader/pk3/PK3Index", () => ({
  PK3Index: {
    getInstance: () => ({
      ensureIndex: mocks.ensureIndex,
      getPK3Path: (filename: string) => `data/${filename}`,
      findMap: (map: string) => `map_${map}.pk3`,
    }),
  },
}));
const { LobbyAssetPreparation } = await import("../LobbyAssetPreparation");

beforeEach(() => {
  mocks.acquire.mockImplementation(async (_url: string, filename: string) => {
    const zip = new JSZip();
    if (filename === "tex_arena.pk3")
      zip.file(
        "media-manifests/arena.json",
        JSON.stringify({
          map: "arena",
          sharedDependencies: [{ package: "tex_billboard.pk3" }],
        }),
      );
    return zip;
  });
});
afterEach(() => vi.clearAllMocks());

it("downloads common assets, only the chosen map and its declared shared bank without mounting", async () => {
  const preparation = new LobbyAssetPreparation();
  preparation.selectMap("arena");
  await vi.waitFor(() => expect(preparation.status().label).toContain("Downloads ready"));
  const filenames = mocks.acquire.mock.calls.map((args) => args[1]);
  expect(filenames).toEqual([
    "washoi_weapons.pk3",
    "washoi_player_model.pk3",
    "washoi_sounds.pk3",
    "washoi_effects.pk3",
    "washoi_gfx.pk3",
    "map_arena.pk3",
    "tex_arena.pk3",
    "tex_billboard.pk3",
  ]);
  expect(mocks.acquire.mock.calls.every((args) => args[2] === "background")).toBe(true);
  expect(preparation.status().packages).toEqual(filenames.map((filename) => ({ filename, state: "Ready" })));
});

it("does not keep scheduling the previous map after the room selection changes", async () => {
  let finish!: (zip: JSZip) => void;
  mocks.acquire.mockImplementationOnce(
    () =>
      new Promise<JSZip>((resolve) => {
        finish = resolve;
      }),
  );
  const preparation = new LobbyAssetPreparation();
  preparation.selectMap("old");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  preparation.selectMap("arena");
  finish(new JSZip());
  await vi.waitFor(() => expect(preparation.status().label).toContain("Downloads ready"));
  expect(mocks.acquire.mock.calls.map((args) => args[1])).not.toContain("map_old.pk3");
  expect(preparation.status().packages.some(({ filename }) => filename.includes("old"))).toBe(false);
});

it("reports an optional failure and retries only on demand", async () => {
  mocks.acquire.mockRejectedValueOnce(new Error("network interrupted"));
  const preparation = new LobbyAssetPreparation();
  preparation.selectMap(null);
  await vi.waitFor(() => expect(preparation.status().label).toContain("Retry"));
  expect(mocks.acquire).toHaveBeenCalledOnce();
  preparation.retry();
  await vi.waitFor(() => expect(preparation.status().label).toContain("Downloads ready"));
});
