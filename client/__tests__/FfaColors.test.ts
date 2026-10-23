import { afterEach, describe, expect, it, vi } from "vitest";
import { Cvar } from "../../../../engine/core/Cvar";
import { MatchStateManager } from "../MatchStateManager";
import { FfaColors, registerPlayerModelVisualCvars } from "../PlayerModelVisualSettings";
import { RemotePlayerRenderer } from "../RemotePlayerRenderer";
import { TEAM_COLORS } from "../settings/SettingsModel";

afterEach(() => {
  Cvar.reset("cl_team_ally_color");
  MatchStateManager.getInstance().reset();
  vi.restoreAllMocks();
});

describe("FFA opponent colours", () => {
  it("gives each opponent a different colour until the palette runs out, never your own", () => {
    registerPlayerModelVisualCvars();
    const colors = new FfaColors();
    const opponents = TEAM_COLORS.length - 1;
    const worn = Array.from({ length: opponents }, (_, i) => colors.colorFor(`p${i}`).id);
    expect(new Set(worn).size).toBe(opponents);
    expect(worn).not.toContain("pink");
    // The next one has to share, and takes a colour worn only once
    expect(worn).toContain(colors.colorFor("one-more").id);
  });

  it("keeps a colour for the session, and deals afresh after a clear", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const colors = new FfaColors();
    const first = colors.colorFor("a");
    expect(colors.colorFor("b")).not.toBe(first);
    expect(colors.colorFor("a")).toBe(first);
    colors.clear();
    expect(colors.colorFor("b")).toBe(first);
  });

  it("follows your own side's colour when you change it", () => {
    registerPlayerModelVisualCvars();
    Cvar.set("cl_team_ally_color", TEAM_COLORS.find((color) => color.id === "lime")!.fill);
    const colors = new FfaColors();
    const worn = Array.from({ length: TEAM_COLORS.length - 1 }, (_, i) => colors.colorFor(`p${i}`).id);
    expect(worn).not.toContain("lime");
    expect(worn).toContain("pink");
  });

  it("colours by gametype: FFA players, whose team the server leaves at spectator, but no team mode", () => {
    const renderer = Object.assign(Object.create(RemotePlayerRenderer.prototype), { ffaColors: new FfaColors() }) as {
      ffaColor(entityId: string, slot: string): { id: string } | null;
    };
    const matchState = (teamBased: boolean) =>
      MatchStateManager.getInstance().processEvent({ type: "match_state", teamBased } as never);

    matchState(false);
    expect(renderer.ffaColor("bot", "ffa")).not.toBeNull();
    // Duel and the other team modes keep the side colours, spectated or not
    matchState(true);
    expect(renderer.ffaColor("bot", "ffa")).toBeNull();
    expect(renderer.ffaColor("bot", "enemy")).toBeNull();
  });
});
