// @vitest-environment jsdom

/**
 * The name and key fields: what they tell a player as they type, and how a
 * pasted key is tidied into groups of four.
 */

import { describe, expect, it } from "vitest";
import { createSlot, judgeName, wireKeySlot } from "../IdentityFields";

describe("judgeName", () => {
  it("asks for a name before saying anything is wrong", () => {
    expect(judgeName("")).toEqual({ ok: false, text: expect.stringContaining("2–16"), tone: "" });
    expect(judgeName("a")).toEqual({ ok: false, text: "One more character", tone: "" });
  });

  it("turns down characters the lobby won't take", () => {
    const verdict = judgeName("no spaces");
    expect(verdict.ok).toBe(false);
    expect(verdict.tone).toBe("bad");
  });

  it("turns down names kept for bots and new players", () => {
    expect(judgeName("Player_12").ok).toBe(false);
    expect(judgeName("Nova").ok).toBe(false);
  });

  it("accepts a name the lobby could give out", () => {
    expect(judgeName("Sundflux")).toEqual({ ok: true, text: "Sundflux looks good", tone: "ok" });
  });
});

describe("key slot", () => {
  it("tidies a pasted key into groups and says when it is whole", () => {
    const slot = createSlot({ id: "key", label: "Key", prefix: "WASHOI-", say: "24 characters." });
    let whole = false;
    wireKeySlot(slot, (_key, complete) => {
      whole = complete;
    });

    slot.input.value = "washoi 6hzq amxe 8844 kn0a 9wcm 71ty";
    slot.input.dispatchEvent(new Event("input"));

    expect(slot.input.value).toBe("6HZQ-AMXE-8844-KN0A-9WCM-71TY");
    expect(whole).toBe(true);
    expect(slot.say.textContent).toBe("That's a whole key");
    expect(slot.say.className).toContain("identity-say--ok");
  });

  it("counts the characters of a part-typed key", () => {
    const slot = createSlot({ id: "key2", label: "Key", prefix: "WASHOI-", say: "24 characters." });
    wireKeySlot(slot, () => {});

    slot.input.value = "6hzq-amxe";
    slot.input.dispatchEvent(new Event("input"));

    expect(slot.input.value).toBe("6HZQ-AMXE");
    expect(slot.say.textContent).toBe("8 / 24 characters");
  });
});

describe("name slot", () => {
  it("counts what is typed, and counts a name put there from elsewhere", () => {
    const slot = createSlot({ id: "name", label: "Name", maxLength: 16, counted: true, say: "2–16 characters" });
    const count = () => slot.root.querySelector(".identity-slot__count")?.textContent;

    slot.input.value = "Sundflux";
    slot.input.dispatchEvent(new Event("input"));
    expect(count()).toBe("8 / 16");

    slot.setValue("Player_4821");
    expect(slot.input.value).toBe("Player_4821");
    expect(count()).toBe("11 / 16");
  });
});
