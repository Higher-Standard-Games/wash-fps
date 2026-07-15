import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  hasActivePlayback: vi.fn(),
  setDemoOverlayVisible: vi.fn(),
  toggleDemoOverlay: vi.fn(),
}));

vi.mock("../../../client/DemoService", () => ({
  DemoService: {
    getInstance: () => service,
  },
}));

import DemoPlayCommand from "../DemoPlayCommand";

describe("DemoPlayCommand HUD controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.hasActivePlayback.mockReturnValue(true);
    service.setDemoOverlayVisible.mockImplementation((visible: boolean) => visible);
    service.toggleDemoOverlay.mockReturnValue(false);
  });

  it("supports on, off, and toggle", async () => {
    const command = new DemoPlayCommand();
    await expect(command.execute(["hud", "on"])).resolves.toBe("Demo HUD on.");
    await expect(command.execute(["hud", "off"])).resolves.toBe("Demo HUD off.");
    await expect(command.execute(["hud", "toggle"])).resolves.toBe("Demo HUD off.");
    expect(service.setDemoOverlayVisible).toHaveBeenNthCalledWith(1, true);
    expect(service.setDemoOverlayVisible).toHaveBeenNthCalledWith(2, false);
    expect(service.toggleDemoOverlay).toHaveBeenCalledOnce();
  });

  it("reports inactive playback and provides HUD completions", async () => {
    const command = new DemoPlayCommand();
    service.hasActivePlayback.mockReturnValue(false);
    await expect(command.execute(["hud", "toggle"])).resolves.toBe("No demo playback is active.");
    expect(command.getCompletions("", ["hud"])).toEqual(["on", "off", "toggle"]);
  });
});
