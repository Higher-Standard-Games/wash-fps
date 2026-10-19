import { afterEach, describe, expect, it, vi } from "vitest";
import { InputButtons } from "../../../../engine/network/components/InputComponent";
import type { Vec3 } from "../../../../engine/network/components/TransformComponent";
import type { StoredInput } from "../InputHistory";
import { V2NetworkClient } from "../V2NetworkClient";

function storedInputs(client: V2NetworkClient): StoredInput[] {
  return (
    client as unknown as {
      inputHistory: { getUnacked(ackedSeq: number): StoredInput[] };
    }
  ).inputHistory.getUnacked(0);
}

describe("V2NetworkClient input sanitization parity", () => {
  it("stores and predicts with the same sanitized command shape the server applies", () => {
    const client = new V2NetworkClient({ tickRate: 125 });
    const seq = client.processInput({
      direction: { x: 1000, y: 99, z: 0 },
      pitch: Math.PI,
      yaw: 3 * Math.PI,
      buttons: InputButtons.FORWARD,
      clientTick: 10,
    });

    expect(seq).toBe(1);
    const [stored] = storedInputs(client);
    expect(stored.direction).toEqual({ x: 1, y: 0, z: 0 });
    expect(stored.pitch).toBeCloseTo(Math.PI / 2, 6);
    expect(stored.yaw).toBeCloseTo(Math.PI, 6);
    expect(stored.buttons).toBe(InputButtons.FORWARD);
  });

  it("neutralizes non-finite local input instead of predicting NaN state", () => {
    const client = new V2NetworkClient({ tickRate: 125 });
    client.processInput({
      direction: { x: Number.NaN, y: 0, z: 0 } as Vec3,
      pitch: 0,
      yaw: 0,
      buttons: InputButtons.FORWARD,
      clientTick: 10,
    });

    const [stored] = storedInputs(client);
    expect(stored.direction).toEqual({ x: 0, y: 0, z: 0 });
    expect(stored.buttons).toBe(0);
    const pos = client.getPosition();
    expect(Number.isFinite(pos.x)).toBe(true);
    expect(Number.isFinite(pos.y)).toBe(true);
    expect(Number.isFinite(pos.z)).toBe(true);
  });
});

// N06: arrival order is not server chronology.
describe("V2NetworkClient snapshot freshness", () => {
  const snapshot = (tick: number, x: number) => ({
    tick,
    ackedInputSeq: 0,
    position: { x, y: 5000, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    grounded: false,
  });

  it("reconciles against the newest tick, not the last one to arrive", () => {
    const client = new V2NetworkClient({ tickRate: 125 });
    client.bufferSnapshot(snapshot(20, 200));
    client.bufferSnapshot(snapshot(18, 100));

    expect(client.processBufferedSnapshots()).toBe(true);
    expect(client.getPosition().x).toBe(200);
  });

  it("ignores a stale snapshot that arrives a frame later, not just in the same batch", () => {
    const client = new V2NetworkClient({ tickRate: 125 });
    client.bufferSnapshot(snapshot(20, 200));
    client.processBufferedSnapshots();

    client.bufferSnapshot(snapshot(18, 100));
    expect(client.processBufferedSnapshots()).toBe(false);
    expect(client.getPosition().x).toBe(200);

    // A duplicate of the newest tick is not newer either.
    client.bufferSnapshot(snapshot(20, 999));
    expect(client.processBufferedSnapshots()).toBe(false);
    expect(client.getPosition().x).toBe(200);

    client.bufferSnapshot(snapshot(21, 210));
    expect(client.processBufferedSnapshots()).toBe(true);
    expect(client.getPosition().x).toBe(210);
  });
});

/**
 * N05: reconciliation is suppressed while a wall jump or ledge grab is eligible,
 * because a replayed trace hits at a slightly different sub-tick point. Every
 * eligible snapshot re-armed a ten-snapshot window, so a player who stayed
 * eligible was never corrected at all, at any divergence.
 */
describe("V2NetworkClient reconciliation suppression bounds", () => {
  afterEach(() => vi.restoreAllMocks());

  const at = (tick: number, x: number) => ({
    tick,
    ackedInputSeq: 0,
    position: { x, y: 5000, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    grounded: false,
  });

  function suppressedClient() {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new V2NetworkClient({ tickRate: 125 });
    client.bufferSnapshot(at(1, 0));
    client.processBufferedSnapshots();
    // Eligible, not charging: the gate tests `!== "none"`, so merely being next
    // to a wall suppresses corrections. Local input recomputes this each tick,
    // so a real player leaves the state — but nothing guarantees they do.
    (client as unknown as { predictedMovement: { wallJumpState: string } }).predictedMovement.wallJumpState =
      "available";
    return client;
  }

  function apply(client: V2NetworkClient, tick: number, x: number) {
    client.bufferSnapshot(at(tick, x));
    client.processBufferedSnapshots();
  }

  it("still suppresses a small correction inside the window", () => {
    const client = suppressedClient();
    const clock = vi.spyOn(performance, "now");
    let t = 1000;
    clock.mockImplementation(() => t);
    for (let tick = 2; tick <= 12; tick++) {
      t += 16; // 62.5Hz, so ~176ms total — inside the intended window
      apply(client, tick, 20);
    }
    // The workaround is intact: this is what protects wall jumps from jitter.
    expect(client.getPosition().x).toBe(0);
  });

  it.each(["wall", "ledge"])("adopts new and cancelled knockback immediately during %s suppression", (kind) => {
    const client = suppressedClient();
    const movement = (
      client as unknown as {
        predictedMovement: { wallJumpState: string; ledgeGrabState: string };
      }
    ).predictedMovement;
    if (kind === "ledge") {
      movement.wallJumpState = "none";
      movement.ledgeGrabState = "grabbing";
    }
    // One movement step per snapshot here, so the ack advances with the tick.
    const correct = (tick: number, age: number | null, vx: number) => {
      client.bufferSnapshot({
        ...at(tick, 0),
        ackedInputSeq: tick,
        knockbackAgeTicks: age,
        velocity: { x: vx, y: 0, z: 0 },
      });
      client.processBufferedSnapshots();
    };
    correct(2, 0, 100); // New authoritative impulse despite zero position error.
    expect(client.getVelocity().x).toBe(100);
    expect(client.getDebugInfo().lastSuppressionRelease).toBe("knockback");
    correct(3, 1, 110); // Same impulse (ack - age stays 2): ordinary suppression remains.
    expect(client.getVelocity().x).toBe(100);
    correct(4, 0, 200); // A second impulse starts a new drag window.
    expect(client.getVelocity().x).toBe(200);
    correct(5, null, 50); // Explicit authoritative cancellation must also be adopted.
    expect(client.getVelocity().x).toBe(50);
  });

  it("gives up suppressing after a bounded time, however long eligibility lasts", () => {
    const client = suppressedClient();
    const clock = vi.spyOn(performance, "now");
    let t = 1000;
    clock.mockImplementation(() => t);

    let tick = 2;
    for (; tick <= 60; tick++) {
      t += 16;
      apply(client, tick, 20);
      if (client.getPosition().x !== 0) break;
    }
    expect(client.getPosition().x).toBe(20);
    // Released on time, not on snapshot count — the bound is in milliseconds so
    // it means the same thing at any snapshot rate.
    expect(client.getDebugInfo().lastSuppressionRelease).toBe("timeout");
    expect(t - 1000).toBeGreaterThan(500);
    expect(t - 1000).toBeLessThan(700);
  });

  it("adopts a hard discontinuity immediately, without waiting out the clock", () => {
    const client = suppressedClient();
    apply(client, 2, 1000); // far beyond any plausible prediction lead
    expect(client.getPosition().x).toBe(1000);
    expect(client.getDebugInfo().lastSuppressionRelease).toBe("divergence");
  });

  it("reports the correction debt a suppressed run accumulated", () => {
    const client = suppressedClient();
    const clock = vi.spyOn(performance, "now");
    let t = 1000;
    clock.mockImplementation(() => t);
    t += 16;
    apply(client, 2, 20);
    t += 16;
    apply(client, 3, 35);

    const debug = client.getDebugInfo();
    expect(debug.suppressedSnapshots).toBe(2);
    expect(debug.maxSuppressedDivergence).toBe(35);
    // Measured from the first suppressed snapshot, not from the last reconcile.
    expect(debug.suppressedForMs).toBe(16);
  });
});

/**
 * N08: the replay budget is a deliberate CPU cap, but replaying only the newest
 * commands from a server state that precedes all of them resumed the client at
 * a position its own history never passed through. The budget is two seconds
 * of commands (250 at 125 Hz).
 */
describe("V2NetworkClient replay budget", () => {
  const AUTHORITY = { x: 0, y: 5000, z: 0 };
  const snap = (tick: number) => ({
    tick,
    ackedInputSeq: 0, // nothing acked, so every predicted input is unacked
    position: { ...AUTHORITY },
    velocity: { x: 0, y: 0, z: 0 },
    grounded: false,
  });

  function afterUnacked(count: number) {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new V2NetworkClient({ tickRate: 125 });
    client.bufferSnapshot(snap(1));
    client.processBufferedSnapshots();
    for (let i = 0; i < count; i++) {
      client.processInput({ direction: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0, buttons: 0, clientTick: i });
    }
    const before = client.getPosition().y;
    client.bufferSnapshot(snap(2));
    client.processBufferedSnapshots();
    return { before, after: client.getPosition().y, debug: client.getDebugInfo() };
  }

  afterEach(() => vi.restoreAllMocks());

  const BUDGET = 250;

  it("replays the whole backlog while it fits in the budget", () => {
    const run = afterUnacked(BUDGET);
    // Authority agrees with the prediction, so nothing should move.
    expect(run.after).toBe(run.before);
    expect(run.debug.resyncCount).toBe(0);
  });

  it("resynchronises rather than replaying a suffix past the budget", () => {
    const run = afterUnacked(BUDGET + 1);
    // One more command must not teleport the player upward, which is what
    // replaying a suffix from the pre-backlog state used to do.
    expect(run.debug.resyncCount).toBe(1);
    expect(run.after).toBe(AUTHORITY.y);
  });

  it("discards the commands it can no longer honour instead of retrying them", () => {
    const run = afterUnacked(BUDGET + 5);
    expect(run.debug.pendingInputs).toBe(0);
  });

  it("holds the boundary steady either side of it", () => {
    expect(afterUnacked(BUDGET - 1).debug.resyncCount).toBe(0);
    expect(afterUnacked(BUDGET).debug.resyncCount).toBe(0);
    expect(afterUnacked(BUDGET + 1).debug.resyncCount).toBe(1);
  });
});
