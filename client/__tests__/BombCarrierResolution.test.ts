import { describe, expect, it, vi } from "vitest";

/**
 * The carried bomb has to resolve the remote renderer per frame, not once.
 *
 * BombRenderer is built on the first frame that has a scene; the remote
 * renderer is built on the first snapshot, which is later. A constructor that
 * took the renderer by value captured `null` for the whole session, so the
 * carried bomb never found a spine and hid itself — the state a bomb spends
 * most of a round in.
 *
 * Reproduced against the resolution rule rather than the Babylon class, so the
 * test needs no scene: what broke was when the lookup happened, not what it
 * drew.
 */
function resolveAnchor(
  getPlayers: () => { getBoneAnchor: (id: string, bone: string) => unknown } | null,
  carrier: string,
): unknown {
  return getPlayers()?.getBoneAnchor(carrier, "Spine1") ?? null;
}

describe("carried bomb anchor resolution", () => {
  it("finds the carrier once the remote renderer exists, even though it did not at construction", () => {
    let renderer: { getBoneAnchor: (id: string, bone: string) => unknown } | null = null;
    const getPlayers = () => renderer;

    // First frame: no snapshot yet, so no remote renderer.
    expect(resolveAnchor(getPlayers, "player_2")).toBeNull();

    // Snapshot arrives and builds it.
    const anchor = { position: { x: 1, y: 2, z: 3 }, yaw: 0.5 };
    renderer = { getBoneAnchor: vi.fn().mockReturnValue(anchor) };

    expect(resolveAnchor(getPlayers, "player_2")).toBe(anchor);
  });

  it("picks up a renderer replaced later in the session", () => {
    const first = { getBoneAnchor: vi.fn().mockReturnValue({ position: { x: 0, y: 0, z: 0 }, yaw: 0 }) };
    const second = { getBoneAnchor: vi.fn().mockReturnValue({ position: { x: 9, y: 9, z: 9 }, yaw: 1 }) };
    let renderer = first;
    const getPlayers = () => renderer;

    resolveAnchor(getPlayers, "player_2");
    expect(first.getBoneAnchor).toHaveBeenCalled();

    // A map change rebuilds the renderer; the bomb must follow the new one.
    renderer = second;
    resolveAnchor(getPlayers, "player_2");
    expect(second.getBoneAnchor).toHaveBeenCalled();
  });
});
