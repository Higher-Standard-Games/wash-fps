// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { seg, slider } from "../SettingsFields";

it("disables native controls, rejects stale events and re-enables with the parent", () => {
  const refreshers: Array<() => void> = [];
  const host = { addRefresh: (f: () => void) => refreshers.push(f), changed() {} };
  const root = document.createElement("div");
  let enabled = false;
  const set = vi.fn();
  slider(host, root, { name: "test", min: 0, max: 1, step: 0.1, get: () => 0, set, enabledIf: () => enabled });
  seg(host, root, { name: "test", choices: [{ value: 1, label: "On" }], get: () => 0, set, enabledIf: () => enabled });
  for (const refresh of refreshers) refresh();
  const input = root.querySelector("input")!;
  const button = root.querySelector("button")!;
  expect(input.disabled).toBe(true);
  expect(button.disabled).toBe(true);
  input.dispatchEvent(new Event("input"));
  button.dispatchEvent(new Event("click"));
  expect(set).not.toHaveBeenCalled();
  enabled = true;
  for (const refresh of refreshers) refresh();
  expect(input.disabled).toBe(false);
  expect(button.disabled).toBe(false);
  button.click();
  expect(set).toHaveBeenCalledOnce();
});
