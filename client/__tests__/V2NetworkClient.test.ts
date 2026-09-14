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

/**
 * N03: reconciliation replays the same unacked inputs over and over. Anything
 * the replay ages by counting steps ages again every time, so the same
 * authoritative state plus the same inputs has to land in the same place.
 */
describe("V2NetworkClient knockback replay", () => {
  const AT = { x: 0, y: 5000, z: 0 };
  const authoritative = (tick: number) => ({
    tick,
    ackedInputSeq: 0, // nothing acked: every predicted input stays in the replay
    position: { ...AT },
    velocity: { x: 0, y: 0, z: 0 },
    grounded: false,
  });

  function predictedAfterReplays(replays: number, steps: number): Vec3 {
    const client = new V2NetworkClient({ tickRate: 125 });
    client.bufferSnapshot(authoritative(1)); // first snapshot seeds local state
    client.processBufferedSnapshots();

    client.applyKnockback(100, { x: 1, y: 0, z: 0 }, 10, true);
    for (let i = 0; i < steps; i++) {
      client.processInput({ direction: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0, buttons: 0, clientTick: i });
    }

    for (let r = 0; r < replays; r++) {
      client.bufferSnapshot(authoritative(2 + r));
      client.processBufferedSnapshots();
    }
    return { ...client.getPosition() };
  }

  it("reconciling twice over the same inputs lands in the same place", () => {
    // 30 steps is inside the free-fly window, so no drag is owed at all. The
    // counter used to carry 30 → 60 → 90 across replays and cross the delay
    // threshold, applying drag the server never applied.
    expect(predictedAfterReplays(2, 30)).toEqual(predictedAfterReplays(1, 30));
    expect(predictedAfterReplays(3, 30)).toEqual(predictedAfterReplays(1, 30));
  });

  it("stays idempotent once the drag phase is genuinely active", () => {
    // Past the 50-step delay, so the replay really does apply drag — the same
    // drag, for the same steps, however many times it runs.
    expect(predictedAfterReplays(2, 90)).toEqual(predictedAfterReplays(1, 90));
    expect(predictedAfterReplays(4, 90)).toEqual(predictedAfterReplays(1, 90));
  });

  it("knockback drag really runs, so idempotence is not just a dead code path", () => {
    // Reconciliation adopts the server's velocity, so the impulse itself is
    // gone by the replay; what the replay still owes is the extra downward
    // pull of the drag phase. Compare y — horizontal drag on zero horizontal
    // velocity would be invisible.
    const withKb = predictedAfterReplays(1, 90);
    const noKb = (() => {
      const client = new V2NetworkClient({ tickRate: 125 });
      client.bufferSnapshot(authoritative(1));
      client.processBufferedSnapshots();
      for (let i = 0; i < 90; i++) {
        client.processInput({ direction: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0, buttons: 0, clientTick: i });
      }
      client.bufferSnapshot(authoritative(2));
      client.processBufferedSnapshots();
      return { ...client.getPosition() };
    })();
    expect(withKb.y).toBeLessThan(noKb.y);
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
