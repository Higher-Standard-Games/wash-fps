// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { registerPlayerModelSelection, setPlayerModelChoice } from "../../PlayerModelSelection";
import type { PlayerTeamPreview } from "../PlayerTeamPreview";

let Preview: typeof PlayerTeamPreview;
beforeAll(async () => {
  ({ PlayerTeamPreview: Preview } =
    await vi.importActual<typeof import("../PlayerTeamPreview")>("../PlayerTeamPreview"));
});
beforeEach(() => {
  registerPlayerModelSelection();
  setPlayerModelChoice("ally", "cartel");
});
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const old = { id: "old" };
  const model = { mesh: { getChildMeshes: () => [], layerMask: 0 } };
  const manager = {
    loadVariant: vi.fn().mockResolvedValue(undefined),
    createInstance: vi.fn().mockReturnValue(model),
    releaseInstance: vi.fn(),
    disposeInstance: vi.fn(),
    playAnimation: vi.fn(),
    applyVisualStyle: vi.fn(),
  };
  const side = {
    side: "ally",
    slot: document.createElement("div"),
    camera: {},
    layer: 1,
    model: old as unknown,
    choice: "police" as string | undefined,
    generation: 0,
  };
  const loading = new Map();
  const preview = Object.assign(Object.create(Preview.prototype), {
    disposed: false,
    initialized: true,
    manager,
    sides: [side],
    loading,
  }) as PlayerTeamPreview;
  return { preview, manager, side, old, model, loading };
}

it("parks replaced bodies instead of disposing shaders that may still be compiling", async () => {
  const { preview, manager, old, side, model } = fixture();
  preview.refresh();
  expect(manager.releaseInstance).toHaveBeenCalledWith(old);
  expect(manager.disposeInstance).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(side.model).toBe(model));
});

it("retries the selected model after a failed load instead of retaining a rejected promise", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { preview, manager, side, model, loading } = fixture();
  manager.loadVariant.mockRejectedValueOnce(new Error("temporary download failure"));
  preview.refresh();
  await vi.waitFor(() => expect(side.choice).toBeUndefined());
  expect(loading.has("cartel")).toBe(false);
  preview.refresh();
  await vi.waitFor(() => expect(side.model).toBe(model));
  expect(manager.loadVariant).toHaveBeenCalledTimes(2);
});
