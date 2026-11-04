import { Simulation } from "@engine/server/core/Simulation";
import { describe, expect, it, vi } from "vitest";
import { InputButtons } from "../../../../engine/network/components/InputComponent";
import type { ClientInfo } from "../Client";
import { Duel } from "../gametypes/Duel";
import { GametypeController } from "../gametypes/GametypeController";
import { buildSnapshot, type SnapshotContext } from "../SnapshotBuilder";
import { CombatSystem } from "../systems/CombatSystem";
import { DroppedWeaponSystem } from "../systems/DroppedWeaponSystem";
import { PickupSystem } from "../systems/PickupSystem";
import { ProjectileSystem } from "../systems/ProjectileSystem";
import { WeaponSystem } from "../systems/WeaponSystem";

/**
 * The scoreboard shows who plays with touch or a controller, from the
 * ASSISTED_AIM bit of each player's newest command, through the roster.
 */
function standingsFor(buttons: Record<number, number>) {
  const simulation = new Simulation({ tickMs: 8 });
  simulation.initialize();
  vi.spyOn(simulation.getState(), "getEntity").mockImplementation(
    (id) => ({ input: { buttons: buttons[id as number] ?? 0 } }) as never,
  );
  const client = (n: number) =>
    ({
      playerId: `p${n}`,
      entityId: n,
      playerName: `Player ${n}`,
      isSpectator: false,
      ping: 0,
    }) as unknown as ClientInfo;
  const ctx: SnapshotContext = {
    simulation,
    weaponSystem: new WeaponSystem(),
    projectileSystem: new ProjectileSystem(),
    combatSystem: new CombatSystem(),
    pickupSystem: new PickupSystem(),
    droppedWeaponSystem: new DroppedWeaponSystem(),
    gametypeController: new GametypeController(new Duel()),
    clients: new Map([
      ["a", client(1)],
      ["b", client(2)],
    ]),
    botNames: new Map(),
    knownProjectileIds: new Set(),
    pendingKillEvents: [],
    pendingChatEvents: [],
    pendingAwards: [],
    needsPickupSync: new Set(),
  };
  const event = buildSnapshot(ctx).events.find((e) => e.type === "match_state") as
    | { standings: Array<{ name: string; assisted?: boolean }> }
    | undefined;
  return event?.standings ?? [];
}

describe("assisted input on the roster", () => {
  it("marks a player whose commands claim touch or a controller, and only them", () => {
    const standings = standingsFor({ 1: InputButtons.ASSISTED_AIM | InputButtons.FIRE, 2: InputButtons.FIRE });
    expect(standings.find((s) => s.name === "Player 1")?.assisted).toBe(true);
    expect(standings.find((s) => s.name === "Player 2")).not.toHaveProperty("assisted");
  });
});
