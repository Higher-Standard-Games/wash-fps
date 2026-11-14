/**
 * BotBlockedMove — the bot asks to move and goes nowhere.
 *
 * A wall, a corner or a lip the steering does not know about can hold a bot
 * still while its state keeps asking to move: a fight pushing at an enemy
 * behind a wall, a dodge into a corner, a retreat into a dead end. Whatever the
 * state, a bot on the ground that has asked to move for BLOCKED_TICKS without
 * leaving BLOCKED_RADIUS of where it was is blocked: it should turn away and
 * think again.
 */

import type { Vec3 } from "./BotGameState";

const TICK_RATE = 125;
/** How long asking to move without going anywhere counts as blocked. */
export const BLOCKED_TICKS = Math.round(0.6 * TICK_RATE);
/** Moving less than this far, across the floor, is going nowhere. */
const BLOCKED_RADIUS = 24;
/** A rise or fall of more than this (a lift, a step, a ladder) is going somewhere. */
const BLOCKED_RISE = 16;

export class BotBlockedMove {
  private _anchor: (Vec3 & { tick: number }) | null = null;

  reset(): void {
    this._anchor = null;
  }

  /**
   * Called every decision with where the bot is and whether it asks to move
   * on the ground. True on the decision it is found blocked; the watch then
   * starts over from there.
   */
  update(tick: number, position: Vec3, asking: boolean): boolean {
    if (!asking) {
      this._anchor = null;
      return false;
    }
    const anchor = this._anchor;
    if (
      !anchor ||
      tick < anchor.tick ||
      Math.hypot(position.x - anchor.x, position.z - anchor.z) > BLOCKED_RADIUS ||
      Math.abs(position.y - anchor.y) > BLOCKED_RISE
    ) {
      this._anchor = { ...position, tick };
      return false;
    }
    if (tick - anchor.tick < BLOCKED_TICKS) return false;
    this._anchor = { ...position, tick };
    return true;
  }
}
