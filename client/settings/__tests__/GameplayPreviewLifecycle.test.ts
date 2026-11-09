// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GameplayPage } from "../GameplayPage";

const preview = vi.hoisted(() => ({
  initialize: vi.fn<() => Promise<void>>(),
  setVisible: vi.fn(),
  refresh: vi.fn(),
  dispose: vi.fn(),
  created: vi.fn(),
}));
vi.mock("../PlayerTeamPreview", () => ({
  PlayerTeamPreview: class {
    constructor() {
      preview.created();
    }
    initialize = preview.initialize;
    setVisible = preview.setVisible;
    refresh = preview.refresh;
    dispose = preview.dispose;
  },
}));

let page: GameplayPage;
let notify: IntersectionObserverCallback;
const disconnect = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  preview.initialize.mockResolvedValue();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        notify = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  page = new GameplayPage({ addRefresh() {}, changed() {} });
  document.body.append(page.root);
});
afterEach(() => {
  page.destroy();
  page.root.remove();
  vi.unstubAllGlobals();
});
function visible(value: boolean): void {
  const target = page.root.querySelector(".fps-set-team-preview")!;
  notify([{ target, isIntersecting: value } as IntersectionObserverEntry], {} as IntersectionObserver);
}

it("starts only when a preview is visible, pauses when hidden and cleans up its observer", async () => {
  expect(preview.created).not.toHaveBeenCalled();
  visible(true);
  await vi.waitFor(() => expect(preview.setVisible).toHaveBeenLastCalledWith(true));
  expect(preview.created).toHaveBeenCalledTimes(1);
  visible(false);
  expect(preview.setVisible).toHaveBeenLastCalledWith(false);
  page.destroy();
  expect(disconnect).toHaveBeenCalled();
  expect(preview.dispose).toHaveBeenCalled();
});

it("does not start a late preview after its settings page has been destroyed", async () => {
  let finish!: () => void;
  preview.initialize.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  visible(true);
  await vi.waitFor(() => expect(preview.initialize).toHaveBeenCalled());
  page.destroy();
  finish();
  await vi.waitFor(() => expect(preview.dispose).toHaveBeenCalled());
  expect(preview.setVisible).not.toHaveBeenCalledWith(true);
});
