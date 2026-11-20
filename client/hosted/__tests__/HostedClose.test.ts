// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("../HostedBuild", () => ({ HOSTED_ON: "itch" }));

const { hostedClosePlate } = await import("../HostedClose");

describe("the hosted close plate", () => {
  it("goes back one step on the host's page when the build runs in its frame", () => {
    const back = vi.fn();
    const framed = { top: {}, document, history: { back } } as unknown as Window;
    const plate = hostedClosePlate(framed);
    expect(plate?.textContent).toBe("✕");
    expect(plate?.getAttribute("aria-label")).toBe("Close the game");
    plate?.click();
    expect(back).toHaveBeenCalledOnce();
  });

  it("is not there when the build is opened on its own", () => {
    expect(hostedClosePlate(window)).toBeNull();
  });
});
