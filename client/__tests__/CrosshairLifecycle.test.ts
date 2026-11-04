// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { PLAY_CHANGE } from "../../../../engine/input/PlayCapture";
import { Crosshair } from "../Crosshair";

/** Every play-change registration made while `run` executes, with its options. */
function playChangeRegistrations(run: () => void): Array<{ signal?: AbortSignal }> {
  const added: Array<{ signal?: AbortSignal }> = [];
  const spy = vi.spyOn(document, "addEventListener").mockImplementation(((
    type: string,
    _listener: unknown,
    options?: AddEventListenerOptions,
  ) => {
    if (type === PLAY_CHANGE) added.push({ signal: options?.signal });
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

  it("ties its play-change listener to an abort signal", () => {
    const added = playChangeRegistrations(() => Crosshair.getInstance().init());
    expect(added).toHaveLength(1);
    expect(added[0].signal).toBeInstanceOf(AbortSignal);
    expect(added[0].signal?.aborted).toBe(false);
  });

  it("releases the listener when disposed", () => {
    let signal: AbortSignal | undefined;
    playChangeRegistrations(() => {
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
      for (const entry of playChangeRegistrations(() => Crosshair.getInstance().init())) signals.push(entry.signal);
      Crosshair.getInstance().dispose();
    }
    // One registration per match, and every earlier one released by the time the next began.
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal?.aborted === true)).toBe(true);
  });

  it("is not re-registered by a second init on the same overlay", () => {
    const first = playChangeRegistrations(() => Crosshair.getInstance().init());
    const second = playChangeRegistrations(() => Crosshair.getInstance().init());
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });
});
