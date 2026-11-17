// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCampaignIntro } from "../CampaignIntro";

// jsdom has no decode(); each test gives images its own
const proto = HTMLImageElement.prototype as unknown as { decode: () => Promise<void> };
proto.decode ??= () => Promise.resolve();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a campaign video's intro", () => {
  it("plays the card when it loads", async () => {
    vi.spyOn(proto, "decode").mockResolvedValue(undefined);
    const intro = await loadCampaignIntro("cartel-contract", new AbortController().signal);
    expect(intro?.seconds).toBeGreaterThan(0);
  });

  it("is left out, not the whole export, when the card will not load", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(proto, "decode").mockRejectedValue(new Error("EncodingError"));
    await expect(loadCampaignIntro("cartel-contract", new AbortController().signal)).resolves.toBeNull();
  });

  it("still stops when the export is cancelled while the card loads", async () => {
    const controller = new AbortController();
    vi.spyOn(proto, "decode").mockImplementation(() => {
      controller.abort();
      return Promise.reject(new Error("aborted"));
    });
    await expect(loadCampaignIntro("cartel-contract", controller.signal)).rejects.toThrow();
  });
});
