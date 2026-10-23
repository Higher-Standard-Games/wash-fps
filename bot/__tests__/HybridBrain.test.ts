/**
 * HybridBrain unit tests
 *
 * Tests the neural network integration without requiring a full game server.
 * Requires @tensorflow/tfjs-node to be installed.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { BotDifficulty } from "../BotConfig";
import { BotGameState } from "../BotGameState";
import { HybridBrain } from "../HybridBrain";
import { getTF, initTF, isTFAvailable } from "../TFBackend";

// ── Test Difficulty ─────────────────────────────────────────────────

const testDifficulty: BotDifficulty = {
  aimAccuracy: 0.5,
  reactionTimeMs: 200,
  trackingSpeed: 3.0,
  predictionSkill: 0.5,
  itemTimingSkill: 0.4,
  strafeJumpSkill: 0.3,
  dodgeSkill: 0.4,
  mistakeRate: 3,
  lookAroundInterval: 3.5,
};

// ── Helpers ─────────────────────────────────────────────────────────

function createGameState(): BotGameState {
  const state = new BotGameState();
  state.selfEntityId = "e_test";
  state.selfPlayerId = "p_test";
  state.tick = 100;
  state.self = {
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    pitch: 0,
    yaw: 0,
    health: 100,
    armor: 50,
    isDead: false,
    isGrounded: true,
    isSliding: false,
    isCrouching: false,
    currentWeapon: "electrobolt",
    weapons: ["electrobolt", "rocketlauncher"],
    ammo: { electrobolt: 10, rocketlauncher: 5 },
    isReloading: false,
    team: "",
  };
  return state;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("HybridBrain", () => {
  // Initialize TF.js once for all tests
  beforeAll(async () => {
    await initTF();
  });

  describe("without models (pure state machine)", () => {
    it("should return valid BotInput when no models are loaded", () => {
      const brain = new HybridBrain(testDifficulty);
      const state = createGameState();

      const input = brain.decide(state);

      expect(input).toBeDefined();
      expect(typeof input.buttons).toBe("number");
      expect(typeof input.yaw).toBe("number");
      expect(typeof input.pitch).toBe("number");
      expect(typeof input.weaponSlot).toBe("number");
      expect(input.direction).toBeDefined();
    });

    it("should report no models loaded", () => {
      const brain = new HybridBrain(testDifficulty);
      expect(brain.hasModels).toBe(false);
      expect(brain.tacticalModel).toBeNull();
      expect(brain.combatModel).toBeNull();
    });
  });

  describe("with fresh models", () => {
    it("should create fresh models without error", async () => {
      if (!isTFAvailable()) return; // Skip if TF not available

      const brain = new HybridBrain(testDifficulty);
      await brain.createFreshModels();

      expect(brain.hasModels).toBe(true);
      expect(brain.tacticalModel).not.toBeNull();
      expect(brain.combatModel).not.toBeNull();

      brain.dispose();
    });

    it("should produce valid output with fresh models", async () => {
      if (!isTFAvailable()) return;

      const brain = new HybridBrain(testDifficulty);
      await brain.createFreshModels();
      const state = createGameState();

      const input = brain.decide(state);

      expect(input).toBeDefined();
      expect(typeof input.buttons).toBe("number");
      expect(Number.isFinite(input.yaw)).toBe(true);
      expect(Number.isFinite(input.pitch)).toBe(true);

      brain.dispose();
    });

    it("should not leak tensors during inference", async () => {
      if (!isTFAvailable()) return;

      const tf = getTF();
      const brain = new HybridBrain(testDifficulty);
      await brain.createFreshModels();
      const state = createGameState();

      // Warm up
      brain.decide(state);

      // Measure tensor count
      const beforeTensors = tf.memory().numTensors;
      for (let i = 0; i < 10; i++) {
        brain.decide(state);
      }
      const afterTensors = tf.memory().numTensors;

      // Should not leak (allow +/- 2 for internal caching)
      expect(afterTensors - beforeTensors).toBeLessThanOrEqual(2);

      brain.dispose();
    });

    it("should dispose models cleanly", async () => {
      if (!isTFAvailable()) return;

      const brain = new HybridBrain(testDifficulty);
      await brain.createFreshModels();
      expect(brain.hasModels).toBe(true);

      brain.dispose();
      expect(brain.hasModels).toBe(false);
    });
  });

  describe("save and load", () => {
    it("should save and reload models", async () => {
      if (!isTFAvailable()) return;

      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shag-brain-test-"));

      try {
        // Create and save
        const brain1 = new HybridBrain(testDifficulty);
        await brain1.createFreshModels();
        await brain1.saveModels(tmpDir);

        // Load into new brain
        const brain2 = new HybridBrain(testDifficulty);
        await brain2.loadModels(tmpDir);

        expect(brain2.hasModels).toBe(true);

        // Both should produce valid output
        const state = createGameState();
        const input = brain2.decide(state);
        expect(input).toBeDefined();

        brain1.dispose();
        brain2.dispose();
      } finally {
        // Cleanup
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
