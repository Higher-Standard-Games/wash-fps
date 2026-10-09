import { afterEach, describe, expect, it, vi } from "vitest";
import { Cvar } from "../../../../engine/core/Cvar";
import { devLog } from "../DevLog";

describe("devLog", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stays quiet unless developer is on", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const developer = vi.spyOn(Cvar, "getBool").mockReturnValue(false);
    devLog("[Death] Event received");
    expect(out).not.toHaveBeenCalled();

    developer.mockReturnValue(true);
    devLog("[Death] Event received", 7);
    expect(out).toHaveBeenCalledWith("[Death] Event received", 7);
    expect(developer).toHaveBeenCalledWith("developer");
  });
});
