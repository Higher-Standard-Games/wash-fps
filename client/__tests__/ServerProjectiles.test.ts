import { describe, expect, it, vi } from "vitest";

const manager = { updateServerPosition: vi.fn(), despawnByEntityId: vi.fn() };
vi.mock("../../../../engine/weapon/ProjectileManager", () => ({ getProjectileManager: () => manager }));

const { ServerProjectiles } = await import("../ServerProjectiles");

const sample = { x: 1, y: 2, z: 3, vx: 3, vy: 0, vz: 4 };

describe("ServerProjectiles", () => {
  it("moves each active projectile to its interpolated position and reports water crossings", () => {
    const projectiles = new ServerProjectiles();
    projectiles.active.add("proj_1");
    projectiles.active.add("proj_2");
    vi.spyOn(projectiles.buffer, "beginFrame").mockImplementation(() => {});
    vi.spyOn(projectiles.buffer, "sampleInFrame").mockImplementation(
      (id: string, out) => (id === "proj_1" ? Object.assign(out, sample) : null) as never,
    );
    const liquid = { notifyProjectile: vi.fn() };

    projectiles.render(liquid as never);

    expect(manager.updateServerPosition).toHaveBeenCalledTimes(1);
    const [id, position, velocity] = manager.updateServerPosition.mock.calls[0];
    expect(id).toBe("proj_1");
    expect([position.x, position.y, position.z]).toEqual([1, 2, 3]);
    expect([velocity.x, velocity.y, velocity.z]).toEqual([3, 0, 4]);
    expect(liquid.notifyProjectile).toHaveBeenCalledWith("proj_1", { x: 1, y: 2, z: 3 }, 5);
  });

  it("renders without a water system", () => {
    const projectiles = new ServerProjectiles();
    projectiles.active.add("proj_1");
    vi.spyOn(projectiles.buffer, "sampleInFrame").mockImplementation((_id, out) => Object.assign(out, sample));
    expect(() => projectiles.render(null)).not.toThrow();
  });

  it("despawns everything and clears its state on reset", () => {
    const projectiles = new ServerProjectiles();
    projectiles.active.add("proj_1");
    projectiles.defIds.set("proj_1", "rocket");
    const bufferReset = vi.spyOn(projectiles.buffer, "reset");
    const forgot: string[] = [];

    projectiles.reset((id) => forgot.push(id));

    expect(manager.despawnByEntityId).toHaveBeenCalledWith("proj_1");
    expect(forgot).toEqual(["proj_1"]);
    expect(projectiles.active.size).toBe(0);
    expect(projectiles.defIds.size).toBe(0);
    expect(bufferReset).toHaveBeenCalled();
  });
});
