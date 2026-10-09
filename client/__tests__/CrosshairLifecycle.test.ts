// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { Crosshair } from "../Crosshair";

/** Every `pointerlockchange` registration made while `run` executes, with its options. */
function pointerLockRegistrations(run: () => void): Array<{ signal?: AbortSignal }> {
  const added: Array<{ signal?: AbortSignal }> = [];
  const spy = vi.spyOn(document, "addEventListener").mockImplementation(((
    type: string,
    _listener: unknown,
    options?: AddEventListenerOptions,
  ) => {
    if (type === "pointerlockchange") added.push({ signal: options?.signal });
  }) as typeof document.addEventListener);
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return added;
}

describe("crosshair listener lifecycle", () => {
  afterEach(() => {
    Crosshair.getInstance().dispose();
    document.body.innerHTML = "";
  });

  it("ties its pointer-lock listener to an abort signal", () => {
    const added = pointerLockRegistrations(() => Crosshair.getInstance().init());
    expect(added).toHaveLength(1);
    expect(added[0].signal).toBeInstanceOf(AbortSignal);
    expect(added[0].signal?.aborted).toBe(false);
  });

  it("releases the listener when disposed", () => {
    let signal: AbortSignal | undefined;
    pointerLockRegistrations(() => {
      Crosshair.getInstance().init();
    }).forEach((entry) => {
      signal = entry.signal;
    });
    expect(signal?.aborted).toBe(false);
    Crosshair.getInstance().dispose();
    expect(signal?.aborted).toBe(true);
  });

  it("does not stack listeners over repeated matches", () => {
    const signals: Array<AbortSignal | undefined> = [];
    for (let match = 0; match < 3; match++) {
      for (const entry of pointerLockRegistrations(() => Crosshair.getInstance().init())) signals.push(entry.signal);
      Crosshair.getInstance().dispose();
    }
    // One registration per match, and every earlier one released by the time the next began.
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal?.aborted === true)).toBe(true);
  });

  it("is not re-registered by a second init on the same overlay", () => {
    const first = pointerLockRegistrations(() => Crosshair.getInstance().init());
    const second = pointerLockRegistrations(() => Crosshair.getInstance().init());
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });
});
