// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlayerProfile } from "../../../../../engine/player/PlayerProfile";
import * as session from "../../../../../lobby/AccountSession";
import NameCommand from "../NameCommand";

const command = new NameCommand();

beforeEach(() => {
  localStorage.clear();
  const profile = PlayerProfile.load();
  profile.name = "LocalPlayer";
  profile.save();
  vi.spyOn(session, "currentIdentity").mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("Washoi name command", () => {
  it("reports local and account identities without renaming", async () => {
    const rename = vi.spyOn(session, "renameAccount");
    await expect(command.execute([])).resolves.toBe("Player name: LocalPlayer  (not logged in to the lobby)");
    vi.mocked(session.currentIdentity).mockReturnValue({ id: "42", name: "OnlinePlayer" });
    await expect(command.execute([])).resolves.toBe("Player name: OnlinePlayer  (account 42)");
    expect(rename).not.toHaveBeenCalled();
  });

  it("persists a local rename without contacting account services", async () => {
    const rename = vi.spyOn(session, "renameAccount");
    await expect(command.execute([" NewPlayer "])).resolves.toBe(
      "Name changed for local play: LocalPlayer → NewPlayer. Online, your account's name is used; rename again once logged in to the lobby.",
    );
    expect(PlayerProfile.load().name).toBe("NewPlayer");
    expect(rename).not.toHaveBeenCalled();
  });

  it("rejects invalid input before renaming or saving", async () => {
    const rename = vi.spyOn(session, "renameAccount");
    await expect(command.execute(["bad", "name"])).resolves.toBe(session.renameFailureText("name_invalid"));
    expect(PlayerProfile.load().name).toBe("LocalPlayer");
    expect(rename).not.toHaveBeenCalled();
  });

  it("awaits the account result instead of changing the local profile itself", async () => {
    vi.mocked(session.currentIdentity).mockReturnValue({ id: "42", name: "OnlinePlayer" });
    let finish!: (result: session.RenameOutcome) => void;
    const rename = vi.spyOn(session, "renameAccount").mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const result = command.execute(["Renamed"]);
    expect(rename).toHaveBeenCalledWith("Renamed");
    expect(PlayerProfile.load().name).toBe("LocalPlayer");
    finish({ ok: true, identity: { id: "42", name: "Renamed" } });
    await expect(result).resolves.toBe("Name changed: OnlinePlayer → Renamed");
  });

  it("returns the account service's refusal without saving a local rename", async () => {
    vi.mocked(session.currentIdentity).mockReturnValue({ id: "42", name: "OnlinePlayer" });
    vi.spyOn(session, "renameAccount").mockResolvedValue({ ok: false, code: "name_reserved" });
    await expect(command.execute(["Ramen"])).resolves.toBe(session.renameFailureText("name_reserved"));
    expect(PlayerProfile.load().name).toBe("LocalPlayer");
  });
});
