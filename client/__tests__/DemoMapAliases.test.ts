import { describe, expect, it } from "vitest";
import { resolveFPSDemoMap } from "../DemoMapAliases";

describe("renamed demo map media", () => {
  it.each([
    ["wdm2", "washoidm2"],
    ["wfdm5", "washoidm5"],
    ["wfdm11", "washoidm11"],
  ])("loads %s recordings against %s", (oldName, newName) => {
    expect(resolveFPSDemoMap(oldName)).toBe(newName);
    expect(resolveFPSDemoMap(`maps/${oldName.toUpperCase()}.BSP`)).toBe(newName);
    expect(resolveFPSDemoMap(newName)).toBe(newName);
  });
  it("preserves other map IDs and missing names", () => {
    expect(resolveFPSDemoMap("wamphi1")).toBe("wamphi1");
    expect(resolveFPSDemoMap("constructor")).toBe("constructor");
    expect(resolveFPSDemoMap(null)).toBe("");
  });
});
