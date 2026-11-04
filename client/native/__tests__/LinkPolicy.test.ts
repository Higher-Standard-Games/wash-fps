import { describe, expect, it } from "vitest";
import { isExternal } from "../LinkPolicy";

describe("isExternal", () => {
  const origin = "https://eu.washoi.net";
  it("keeps this site's pages in the webview", () => {
    expect(isExternal("/client", origin)).toBe(false);
    expect(isExternal("https://eu.washoi.net/devlog", origin)).toBe(false);
  });
  it("sends other sites to the browser", () => {
    expect(isExternal("https://washoi.net/", origin)).toBe(true);
    expect(isExternal("https://github.com/x", origin)).toBe(true);
  });
  it("leaves other schemes and nonsense alone", () => {
    expect(isExternal("mailto:a@b.c", origin)).toBe(false);
    expect(isExternal("javascript:void 0", origin)).toBe(false);
  });
});
