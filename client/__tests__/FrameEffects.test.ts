import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FrameEffects loads each effect system on first use, initialises it once a
 * scene exists, and ticks it every frame after that. These tests pin that life
 * cycle, which it inherited from Game.renderRemotePlayers.
 */

function system(name: string) {
  return {
    name,
    scene: null as unknown,
    init: vi.fn(function (this: { scene: unknown }, scene: unknown) {
      this.scene = scene;
    }),
    update: vi.fn(),
    spawn: vi.fn(),
    setGibCallback: vi.fn(),
  };
}

const gibs = system("gibs");
const ragdolls = system("ragdolls");
const damageNumbers = system("damageNumbers");
const damageOverlay = system("damageOverlay");
const cartoon = system("cartoon");

vi.mock("../GibSystem", () => ({ GibSystem: { getInstance: () => gibs } }));
vi.mock("../RagdollSystem", () => ({ RagdollSystem: { getInstance: () => ragdolls } }));
vi.mock("../DamageNumbers", () => ({ DamageNumbers: { getInstance: () => damageNumbers } }));
vi.mock("../../../../engine/ui/hud/DamageOverlay", () => ({ DamageOverlay: { getInstance: () => damageOverlay } }));
vi.mock("../CartoonHitEffect", () => ({ CartoonHitEffect: { getInstance: () => cartoon } }));

const { FrameEffects } = await import("../FrameEffects");

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const frame = async (effects: InstanceType<typeof FrameEffects>, dt = 0.016) => {
  effects.updateGibs(dt);
  effects.updateHitEffects(dt);
  await settle();
};

describe("FrameEffects", () => {
  beforeEach(() => {
    for (const s of [gibs, ragdolls, damageNumbers, damageOverlay, cartoon]) {
      s.scene = null;
      s.init.mockClear();
      s.update.mockClear();
      s.spawn.mockClear();
      s.setGibCallback.mockClear();
    }
  });

  it("initialises every system on the first frame with a scene, then ticks them", async () => {
    const scene = { id: "scene" };
    const effects = new FrameEffects(() => scene as never);
    await frame(effects);
    expect(gibs.init).toHaveBeenCalledWith(scene);
    expect(ragdolls.init).toHaveBeenCalledWith(scene);
    expect(cartoon.init).toHaveBeenCalledWith(scene);
    expect(effects.gibSystem).toBe(gibs);
    expect(effects.ragdollSystem).toBe(ragdolls);
    expect(effects.cartoonHit).toBe(cartoon);
    expect(gibs.update).not.toHaveBeenCalled();

    damageNumbers.scene = scene; // DamageNumbers is initialised elsewhere; it is adopted once it has a scene
    await frame(effects);
    await frame(effects, 0.5);
    expect(gibs.update).toHaveBeenLastCalledWith(0.5);
    expect(ragdolls.update).toHaveBeenLastCalledWith(0.5);
    expect(cartoon.update).toHaveBeenLastCalledWith(0.5);
    expect(damageOverlay.update).toHaveBeenLastCalledWith(0.5);
    expect(damageNumbers.update).toHaveBeenLastCalledWith(0.5);
  });

  it("flushes gibs queued while the gib system was loading", async () => {
    const effects = new FrameEffects(() => ({}) as never);
    effects.pendingGibSpawns.push({ x: 1, y: 2, z: 3, vx: 4, vy: 5, vz: 6 });
    await frame(effects);
    expect(gibs.spawn).toHaveBeenCalledWith(1, 2, 3, 4, 5, 6);
    expect(effects.pendingGibSpawns).toEqual([]);
  });

  it("retries on a later frame when there is no scene yet", async () => {
    let scene: object | null = null;
    const effects = new FrameEffects(() => scene as never);
    await frame(effects);
    expect(effects.gibSystem).toBeNull();
    expect(effects.ragdollSystem).toBeNull();
    expect(effects.cartoonHit).toBeNull();

    scene = {};
    await frame(effects);
    expect(effects.gibSystem).toBe(gibs);
    expect(effects.ragdollSystem).toBe(ragdolls);
    expect(effects.cartoonHit).toBe(cartoon);
  });

  it("wires ragdoll gibbing to the gib system once both are loaded", async () => {
    const effects = new FrameEffects(() => ({}) as never);
    await frame(effects);
    expect(ragdolls.setGibCallback).toHaveBeenCalledTimes(1);
    const gibCallback = ragdolls.setGibCallback.mock.calls[0][0] as (...n: number[]) => void;
    gibCallback(1, 2, 3, 4, 5, 6);
    expect(gibs.spawn).toHaveBeenCalledWith(1, 2, 3, 4, 5, 6);
  });
});
