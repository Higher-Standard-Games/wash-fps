import { describe, expect, it } from "vitest";
import { InputClaims } from "../InputClaims";

describe("input claims", () => {
  it("leaves a free channel open to corrections and takeovers", () => {
    const claims = new InputClaims();
    expect(claims.owner("movement")).toBeNull();
    expect(claims.mayCorrect("movement")).toBe(true);
    expect(claims.mayTakeOver("movement")).toBe(true);
  });

  it("lets a hold for corrections be steered but not replaced", () => {
    const claims = new InputClaims();
    claims.hold("movement", "guard patrol", "corrections");
    expect(claims.mayCorrect("movement")).toBe(true);
    expect(claims.mayTakeOver("movement")).toBe(false);
    expect(claims.mayTakeOver("view")).toBe(true);
  });

  it("keeps an exact hold exact, and frees every channel on a new decision", () => {
    const claims = new InputClaims();
    claims.hold("movement", "precise approach", "exact");
    claims.hold("movement", "guard patrol", "corrections");
    expect(claims.owner("movement")).toBe("precise approach");
    expect(claims.mayCorrect("movement")).toBe(false);
    claims.begin();
    expect(claims.owner("movement")).toBeNull();
    expect(claims.mayCorrect("movement")).toBe(true);
  });
});
