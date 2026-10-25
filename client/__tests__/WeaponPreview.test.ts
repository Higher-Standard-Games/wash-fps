// @vitest-environment jsdom

/**
 * The kit picker's weapon stand runs on its own engine. Overlapping `show`
 * calls must share that engine, and disposing the stand must stop it: an
 * engine nobody holds keeps rendering to a detached canvas all match.
 */
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { afterEach, describe, expect, it, vi } from "vitest";

const engines = vi.hoisted(() => [] as NullEngine[]);
const assets = vi.hoisted(() => ({
  source: new Uint8Array([1, 2, 3]),
  options: { pluginExtension: ".glb", rootUrl: "" },
}));
const importMesh = vi.hoisted(() => vi.fn(() => Promise.reject(new Error("no model in tests"))));
const resolveAsset = vi.hoisted(() => vi.fn(async (_path: string) => assets));
const renderLoops = (engine: NullEngine) => (engine as unknown as { _activeRenderLoops: unknown[] })._activeRenderLoops;

vi.mock("@babylonjs/core/Engines/engine", () => ({
  Engine: class extends NullEngine {
    constructor() {
      super();
      engines.push(this);
    }
  },
}));
vi.mock("@babylonjs/core/Loading/sceneLoader", () => ({
  ImportMeshAsync: importMesh,
}));
vi.mock("../../../../engine/loader/model/ModelAsset", () => ({ resolveModelAsset: resolveAsset }));

import { WeaponPreview } from "../hud/widgets/WeaponPreview";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  engines.length = 0;
  vi.clearAllMocks();
});

describe("weapon stand engine", () => {
  it("loads packaged model bytes through the shared asset resolver", async () => {
    const preview = new WeaponPreview();
    try {
      await preview.show("/data/models/weapons/rlauncher/rlauncher.glb");
      expect(resolveAsset).toHaveBeenCalledWith("/data/models/weapons/rlauncher/rlauncher.glb");
      expect(importMesh).toHaveBeenCalledWith(assets.source, expect.anything(), assets.options);
    } finally {
      preview.dispose();
    }
  });
  it("builds one engine for overlapping shows, and dispose stops it", async () => {
    const preview = new WeaponPreview();
    void preview.show("models/a/a.glb");
    void preview.show("models/b/b.glb");
    await vi.waitFor(() => expect(engines.length).toBeGreaterThan(0), { timeout: 5000 });
    await wait(50);

    expect(engines).toHaveLength(1);
    expect(renderLoops(engines[0])).toHaveLength(1);
    preview.dispose();
    expect(engines[0].isDisposed).toBe(true);
  });

  it("leaves no engine running when disposed while still building", async () => {
    const preview = new WeaponPreview();
    void preview.show("models/a/a.glb");
    preview.dispose();
    await wait(500);

    expect(engines.filter((engine) => !engine.isDisposed)).toHaveLength(0);
  });
});
