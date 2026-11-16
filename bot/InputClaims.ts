/**
 * Who owns each input channel of a decision, and what the steps after the
 * owner may do to it. A decision's input has three channels:
 *
 * - **movement**: `direction`, `moveYaw` and the movement keys (forward,
 *   back, sides, jump, crouch, sprint);
 * - **view**: `yaw` and `pitch`;
 * - **buttons**: fire, alt-fire and the weapon slot.
 *
 * The state's executor writes all three. A step that sets up a move it means
 * exactly (a running sequence, a verified approach to a trick) or a move to
 * keep as it is (a guard's walk round its spot) holds the channel, and the
 * steps after it check before they touch it (StateMachineBrain._afterSteps):
 *
 * - a **correction** keeps the move's own aim and adjusts how it gets there
 *   (wall clearance, a climb or wall jump toward the same point): allowed
 *   unless the channel is held exactly;
 * - a **takeover** replaces the move with another (a slide, a strafe hop):
 *   allowed only on a channel nobody holds.
 *
 * Combat orders (keeping the high ground, the leash) answer the fight and
 * take movement whoever holds it. Each decision starts with every channel
 * free.
 */

export type InputChannel = "movement" | "view" | "buttons";

/** How a holder lets later steps touch its channel. */
export type InputHold = "corrections" | "exact";

interface Claim {
  owner: string;
  hold: InputHold;
}

export class InputClaims {
  private readonly _claims = new Map<InputChannel, Claim>();

  /** A new decision: every channel free. */
  begin(): void {
    this._claims.clear();
  }

  /** `owner` holds `channel`; an exact hold already there stays exact. */
  hold(channel: InputChannel, owner: string, hold: InputHold): void {
    const held = this._claims.get(channel);
    if (held?.hold === "exact" && hold !== "exact") return;
    this._claims.set(channel, { owner, hold });
  }

  /** Who holds `channel` this decision, or null when it is free. */
  owner(channel: InputChannel): string | null {
    return this._claims.get(channel)?.owner ?? null;
  }

  /** Whether a correction may adjust `channel`: it is not held exactly. */
  mayCorrect(channel: InputChannel): boolean {
    return this._claims.get(channel)?.hold !== "exact";
  }

  /** Whether a takeover may replace `channel`: nobody holds it. */
  mayTakeOver(channel: InputChannel): boolean {
    return !this._claims.has(channel);
  }
}
