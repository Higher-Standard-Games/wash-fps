/**
 * Summaries of decision traces (DecisionTrace.ts) over a run, for the bot
 * tools: what a bot was doing while it stood still, and while its crouch
 * changed. One `add` per command sent; a command lasts a server tick.
 */

import type { DecisionTrace } from "./DecisionTrace";

const TICK_SECONDS = 1 / 125;
/** Slower than this, on the ground, counts as standing still (units per second). */
export const STILL_SPEED = 20;

/** What the bot was doing, in a few words: state, then sequence or path step, then any block. */
export function traceCause(trace: DecisionTrace): string {
  const parts = [trace.state];
  if (trace.sequence) {
    const [sequence, phase] = trace.sequence.split(" ");
    parts.push(`${sequence.replace("sequence=", "")}${phase?.startsWith("phase=") ? ` ${phase.slice(6)}` : ""}`);
  } else if (trace.step) {
    parts.push(`${trace.step.type}${trace.step.route ? ` ${trace.step.route.split(":")[0]}` : ""}`);
  } else parts.push(trace.goal ? "no step" : "no goal");
  if (trace.blocked) parts.push(`blocked ${trace.blocked.split(":").slice(0, 2).join(":")}`);
  return parts.join(" | ");
}

export class TraceStats {
  /** Seconds standing still, by cause. */
  readonly stillByCause = new Map<string, number>();
  /** Crouch changes, by state. */
  readonly crouchChangesByState = new Map<string, number>();
  private alive = 0;
  private still = 0;
  private readonly lastCrouch = new Map<string, boolean>();

  /** One command sent by `bot`, with the trace of the decision it carries. */
  add(bot: string, trace: DecisionTrace, self: { isDead: boolean; isCrouching: boolean }): void {
    if (self.isDead) {
      this.lastCrouch.delete(bot);
      return;
    }
    this.alive += TICK_SECONDS;
    if (trace.grounded && trace.speed < STILL_SPEED) {
      this.still += TICK_SECONDS;
      const cause = traceCause(trace);
      this.stillByCause.set(cause, (this.stillByCause.get(cause) ?? 0) + TICK_SECONDS);
    }
    const before = this.lastCrouch.get(bot);
    if (before !== undefined && before !== self.isCrouching) {
      this.crouchChangesByState.set(trace.state, (this.crouchChangesByState.get(trace.state) ?? 0) + 1);
    }
    this.lastCrouch.set(bot, self.isCrouching);
  }

  /** Report lines: share of alive time still, its top causes, and crouch changes by state. */
  lines(top = 8): string[] {
    const pct = (seconds: number) => `${((100 * seconds) / Math.max(1e-9, this.alive)).toFixed(1)}%`;
    const out = [`  traced still    ${pct(this.still)} of alive time; by cause:`];
    for (const [cause, seconds] of [...this.stillByCause].sort((a, b) => b[1] - a[1]).slice(0, top)) {
      out.push(`    ${pct(seconds).padStart(6)}  ${cause}`);
    }
    const crouch = [...this.crouchChangesByState].sort((a, b) => b[1] - a[1]);
    const minutes = this.alive / 60;
    out.push(
      `  crouch changes  ${crouch.map(([state, n]) => `${state} ${(n / Math.max(1e-9, minutes)).toFixed(0)}`).join(", ") || "none"} per bot-minute`,
    );
    return out;
  }
}
