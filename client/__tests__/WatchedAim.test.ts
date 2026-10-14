/**
 * Watching someone aim down sights: a recording's commands say who held alt
 * fire, and the watched view zooms as theirs did, with the same zoom the local
 * camera uses.
 */

import { describe, expect, it } from "vitest";
import { InputButtons } from "../../../../engine/network/components/InputComponent";
import { GameState } from "../../../../engine/network/core/GameState";
import { AdsZoom, FirstPersonEffectStack } from "../../../../engine/viewport/FirstPersonEffects";
import { createNeutralPlayerState } from "../../../../engine/viewport/PlayerState";
import type { RecordedInput } from "../../../../shared/demo/DemoInputs";
import { DemoService } from "../DemoService";

describe("aiming down sights", () => {
  it("eases into the zoom and back out", () => {
    const zoom = new AdsZoom();
    // cl_ads_time 0.08 s, cl_ads_fov_reduction 15%
    expect(zoom.step(1, true)).toBeCloseTo(0.85);
    expect(zoom.step(0.02, false)).toBeGreaterThan(0.85);
    expect(zoom.step(1, false)).toBe(1);
  });

  it("zooms a watched view while its player aims", () => {
    const stack = new FirstPersonEffectStack();
    const state = { ...createNeutralPlayerState(), isAiming: true };
    let multiplier = 1;
    for (let i = 0; i < 30; i++) multiplier = stack.update(1 / 60, state).fovMultiplier;
    expect(multiplier).toBeCloseTo(0.85, 2);
  });

  it("reads who held alt fire from a frame's commands", () => {
    const state = new GameState();
    state.players.set("player_3", { entityId: "player_30", name: "Ramen" } as never);
    state.players.set("player_4", { entityId: "player_40", name: "Udon" } as never);
    const input = (playerId: string, buttons: number): RecordedInput => ({
      playerId,
      buttons,
      yaw: 0,
      pitch: 0,
      forward: 0,
      right: 0,
      weaponSlot: 1,
      commands: 1,
    });
    const service = DemoService.getInstance() as unknown as {
      noteAiming(state: GameState, inputs: readonly RecordedInput[]): void;
      _aimingEntities: Set<string>;
    };
    service.noteAiming(state, [input("3", InputButtons.ALT_FIRE), input("4", InputButtons.FIRE)]);
    expect([...service._aimingEntities]).toEqual(["player_30"]);
    service.noteAiming(state, []);
    expect(service._aimingEntities.size).toBe(0);
  });
});
