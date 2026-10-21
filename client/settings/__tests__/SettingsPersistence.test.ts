// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Cvar } from "../../../../../engine/core/Cvar";
import { writePreference } from "../../../../../engine/core/PreferenceStorage";
import { InputSystem } from "../../../../../engine/input/InputSystem";
import { FPS } from "../../FPSActions";
import { FPSSettingsView } from "../FPSSettingsView";

let view: FPSSettingsView;
afterEach(() => {
  view?.destroy();
  vi.restoreAllMocks();
  for (const key of ["engine_cvars", "shag_keybindings", "ui_theme_mode"])
    writePreference(key, localStorage.getItem(key) ?? "{}");
  document.body.replaceChildren();
  delete (document.documentElement as unknown as { requestFullscreen?: unknown }).requestFullscreen;
  Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
});
describe("truthful settings persistence", () => {
  it("explains fullscreen failure, retains Off and permits a successful retry", async () => {
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
    document.documentElement.requestFullscreen = vi
      .fn()
      .mockRejectedValueOnce(new Error("Denied"))
      .mockImplementationOnce(async () => {
        Object.defineProperty(document, "fullscreenElement", { configurable: true, value: document.documentElement });
        document.dispatchEvent(new Event("fullscreenchange"));
      });
    view = new FPSSettingsView();
    document.body.append(view.getElement());
    const group = view.getElement().querySelector('[aria-label="Fullscreen"]')!;
    const [off, on] = [...group.querySelectorAll<HTMLButtonElement>("button")];
    on.click();
    await vi.waitFor(() =>
      expect(document.querySelector(".fps-set-toast")?.textContent).toContain("could not change fullscreen"),
    );
    expect(off.getAttribute("aria-pressed")).toBe("true");
    expect(on.getAttribute("aria-pressed")).toBe("false");
    on.click();
    await vi.waitFor(() => expect(on.getAttribute("aria-pressed")).toBe("true"));
    expect(document.documentElement.requestFullscreen).toHaveBeenCalledTimes(2);
  });
  it.each(["cvars", "bindings"])(
    "shows a session-only status after failed %s writes and clears it after success",
    (kind) => {
      view = new FPSSettingsView();
      document.body.append(view.getElement());
      const saved = view.getElement().querySelector<HTMLElement>(".fps-set-saved")!;
      const blocked = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("Storage denied", "SecurityError");
      });
      if (kind === "cvars") Cvar.set("m_sensitivity", Cvar.getNumber("m_sensitivity") + 0.25);
      else InputSystem.getInstance().rebind(FPS.JUMP, [{ key: "KeyP" }]);
      expect(saved.textContent).toContain("could not save");
      expect(saved.title).toContain("reload");
      expect(saved.classList.contains("is-session-only")).toBe(true);
      if (kind === "bindings")
        expect(InputSystem.getInstance().getBindingsForAction(FPS.JUMP)).toEqual([{ key: "KeyP" }]);
      blocked.mockRestore();
      if (kind === "cvars") Cvar.set("m_sensitivity", Cvar.getNumber("m_sensitivity") + 0.25);
      else InputSystem.getInstance().resetBinding(FPS.JUMP);
      expect(saved.textContent).toBe("Saved as you go");
      view.destroy();
      writePreference("engine_cvars", "{}");
      expect(saved.textContent).toBe("Saved as you go");
    },
  );
});
