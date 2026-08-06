import { describe, expect, it } from "vitest";
import { DEFAULT_BOMB_RULES } from "../../../../shared/server/gametype/BombModel";
import { DEFAULT_PHYSICS_TICK_RATE } from "../../../../shared/server/simulation/physics/constants";

/**
 * The last call warns each side the same distance from ITS OWN deadline.
 *
 * The deadline is not the clock reaching zero — it is the last moment the job
 * could still be started and finished. An attacker with three seconds left
 * cannot complete a four-second arm, so their round is already lost; a defender
 * needs a whole defuse to fit inside the remaining fuse. A single fixed clock
 * reading would be early for one side and useless for the other.
 *
 * Reproduced against the rule rather than the audio class, which needs an
 * AudioManager and a decoded sound bank to instantiate.
 */
const LEAD = 5;
const ARM = DEFAULT_BOMB_RULES.armTicks / DEFAULT_PHYSICS_TICK_RATE;
const DEFUSE = DEFAULT_BOMB_RULES.defuseTicks / DEFAULT_PHYSICS_TICK_RATE;

function attackerDue(timeRemaining: number, armed: boolean): boolean {
  return !armed && timeRemaining > 0 && timeRemaining <= ARM + LEAD;
}

function defenderDue(fuse: number | null, armed: boolean): boolean {
  return armed && fuse !== null && fuse <= DEFUSE + LEAD;
}

describe("attacker last call", () => {
  it("fires five seconds before an arm stops fitting in the round", () => {
    // Arm is 4s, so the true deadline is 4s left; warn at 9s.
    expect(ARM).toBe(4);
    expect(attackerDue(ARM + LEAD, false)).toBe(true);
    expect(attackerDue(ARM + LEAD + 0.5, false)).toBe(false);
  });

  it("stops mattering once the bomb is armed", () => {
    // The attack has done its job; the round clock is no longer their problem.
    expect(attackerDue(2, true)).toBe(false);
  });

  it("does not fire on an expired clock", () => {
    expect(attackerDue(0, false)).toBe(false);
  });
});

describe("defender last call", () => {
  it("fires five seconds before a defuse stops fitting in the fuse", () => {
    // Defuse is 7s, so the true deadline is 7s of fuse; warn at 12s.
    expect(DEFUSE).toBe(7);
    expect(defenderDue(DEFUSE + LEAD, true)).toBe(true);
    expect(defenderDue(DEFUSE + LEAD + 0.5, true)).toBe(false);
  });

  it("says nothing while the bomb is not armed — there is nothing to defuse", () => {
    expect(defenderDue(null, false)).toBe(false);
    expect(defenderDue(3, false)).toBe(false);
  });

  it("warns later on the clock than the attacker, because a defuse takes longer", () => {
    // Both get 5 seconds of warning; the readings differ because the jobs do.
    expect(DEFUSE + LEAD).toBeGreaterThan(ARM + LEAD);
  });
});
