/**
 * The slide-blade lunge: starts only from a run at slide speed toward an
 * enemy one slide away on a clear floor, swings on arrival, and jumps out
 * with the gun back out when it misses.
 */

import { describe, expect, it } from "vitest";
import { InputButtons } from "../BotConfig";
import { BotGameState, type VisiblePlayer } from "../BotGameState";
import { BotSequenceRegistry, BotSequenceRuntime } from "../BotSequence";
import type { BotVision } from "../BotVision";
import { lungeChance } from "../StateMachineBrain";
import { canLunge, SlideBladeSequence } from "../sequences/SlideBladeSequence";

function scene(enemyZ: number, walkable = true) {
  const state = new BotGameState();
  state.tick = 0;
  state.self.position = { x: 0, y: 0, z: 0 };
  state.self.velocity = { x: 0, y: 0, z: 420 };
  state.self.isGrounded = true;
  state.self.weapons = ["machinegun", "blade"];
  state.self.currentWeapon = "machinegun";
  const enemy: VisiblePlayer = {
    entityId: "e",
    playerId: "foe",
    position: { x: 0, y: 0, z: enemyZ },
    velocity: { x: 0, y: 0, z: 0 },
    isDead: false,
    team: "",
    relation: "enemy",
    distance: enemyZ,
  };
  state.players = [enemy];
  const vision = { isWalkable: () => walkable } as unknown as BotVision;
  const context = { state, vision, combatTarget: enemy, difficulty: null };
  return { state, enemy, context };
}

describe("when a lunge may start", () => {
  it("needs slide speed, a target one slide away ahead, and a clear floor", () => {
    const { context, enemy } = scene(350);
    expect(canLunge(context, enemy)).toBe(true);
    expect(canLunge(scene(150).context, scene(150).enemy)).toBe(false); // just swing
    expect(canLunge(scene(600).context, scene(600).enemy)).toBe(false); // out of reach
    expect(canLunge(scene(350, false).context, scene(350, false).enemy)).toBe(false); // ledge or wall

    const slow = scene(350);
    slow.state.self.velocity = { x: 0, y: 0, z: 300 };
    expect(canLunge(slow.context, slow.enemy)).toBe(false);

    const sideways = scene(350);
    sideways.state.self.velocity = { x: 420, y: 0, z: 0 };
    expect(canLunge(sideways.context, sideways.enemy)).toBe(false);

    const noBlade = scene(350);
    noBlade.state.self.weapons = ["machinegun"];
    expect(canLunge(noBlade.context, noBlade.enemy)).toBe(false);
  });

  it("is taken more often the better the bot dodges", () => {
    expect(lungeChance(0.15)).toBe(0); // Easy
    expect(lungeChance(0.4)).toBeCloseTo(0.25, 6);
    expect(lungeChance(0.7)).toBeCloseTo(0.6, 6);
    expect(lungeChance(0.9)).toBeCloseTo(0.85, 6);
  });
});

function runtime() {
  const registry = new BotSequenceRegistry();
  registry.register(new SlideBladeSequence());
  return new BotSequenceRuntime(registry);
}

describe("the lunge", () => {
  it("slides in with the blade and swings on arrival", () => {
    const { state, context } = scene(350);
    const run = runtime();
    expect(run.start("combat_slide_blade", context)).toBe(true);

    const slide = run.tick(context)!;
    expect(slide.phase).toBe("slide");
    expect(slide.input.buttons & InputButtons.CROUCH).not.toBe(0);
    expect(slide.input.weaponSlot).toBe(2);

    state.tick = 30;
    state.self.isSliding = true;
    state.self.currentWeapon = "blade";
    state.self.position = { x: 0, y: 0, z: 220 };
    const strike = run.tick(context)!;
    expect(strike.phase).toBe("strike");
    expect(strike.input.buttons & InputButtons.FIRE).not.toBe(0);

    state.tick = 60;
    expect(run.tick(context)).toMatchObject({ status: "succeeded" });
  });

  it("jumps out sideways and takes the gun back out when it misses", () => {
    const { state, context, enemy } = scene(350);
    const run = runtime();
    run.start("combat_slide_blade", context);
    run.tick(context);

    state.tick = 30;
    state.self.isSliding = true;
    state.self.currentWeapon = "blade";
    run.tick(context);
    // The enemy got away; the slide ran out.
    enemy.position = { x: 0, y: 0, z: 900 };
    state.tick = 130;
    state.self.isSliding = false;
    const exit = run.tick(context)!;
    expect(exit).toMatchObject({ status: "running", phase: "exit" });
    expect(exit.input.buttons & InputButtons.JUMP).not.toBe(0);
    expect(exit.input.weaponSlot).toBe(1);

    state.tick = 150;
    expect(run.tick(context)).toMatchObject({ status: "failed", reason: "missed" });
  });
});
