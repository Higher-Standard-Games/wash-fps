import { describe, expect, it } from "vitest";
import type { VisiblePlayer } from "../BotGameState";
import { BotGameState } from "../BotGameState";
import { buildCombatInput, buildTacticalInput, COMBAT_INPUT_SIZE, TACTICAL_INPUT_SIZE } from "../BotInputNormalizer";

// ── Helpers ─────────────────────────────────────────────────────────

function createMinimalGameState(): BotGameState {
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

function createEnemy(): VisiblePlayer {
  return {
    entityId: "e_enemy",
    playerId: "p_enemy",
    position: { x: 100, y: 0, z: 200 },
    velocity: { x: 50, y: 0, z: -30 },
    isDead: false,
    team: "",
    relation: "enemy",
    distance: 223.6, // sqrt(100² + 200²)
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("BotInputNormalizer", () => {
  describe("buildTacticalInput", () => {
    it("should return exactly TACTICAL_INPUT_SIZE floats", () => {
      const state = createMinimalGameState();
      const result = buildTacticalInput(state, null);

      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBe(TACTICAL_INPUT_SIZE);
    });

    it("should produce values in [0, 1] range", () => {
      const state = createMinimalGameState();
      const result = buildTacticalInput(state, null);

      for (let i = 0; i < result.length; i++) {
        expect(result[i]).toBeGreaterThanOrEqual(0);
        expect(result[i]).toBeLessThanOrEqual(1);
      }
    });

    it("should handle zero/empty state without NaN", () => {
      const state = new BotGameState();
      const result = buildTacticalInput(state, null);

      expect(result.length).toBe(TACTICAL_INPUT_SIZE);
      for (let i = 0; i < result.length; i++) {
        expect(Number.isNaN(result[i])).toBe(false);
        expect(Number.isFinite(result[i])).toBe(true);
      }
    });

    it("should handle dead player state", () => {
      const state = createMinimalGameState();
      state.self.isDead = true;
      state.self.health = 0;

      const result = buildTacticalInput(state, null);

      expect(result.length).toBe(TACTICAL_INPUT_SIZE);
      for (let i = 0; i < result.length; i++) {
        expect(Number.isNaN(result[i])).toBe(false);
      }
    });

    it("should encode health correctly (normalized to ~0.5 at 100hp)", () => {
      const state = createMinimalGameState();
      state.self.health = 100;
      const result = buildTacticalInput(state, null);

      // Health index is 0, max health is typically 200
      // 100/200 = 0.5
      expect(result[0]).toBeCloseTo(0.5, 1);
    });

    it("should vary output with different enemy counts", () => {
      const state = createMinimalGameState();

      const noEnemies = buildTacticalInput(state, null);

      state.players = [createEnemy()];
      const withEnemy = buildTacticalInput(state, null);

      // Outputs should differ when enemies are present
      let different = false;
      for (let i = 0; i < TACTICAL_INPUT_SIZE; i++) {
        if (Math.abs(noEnemies[i] - withEnemy[i]) > 0.001) {
          different = true;
          break;
        }
      }
      expect(different).toBe(true);
    });
  });

  describe("buildCombatInput", () => {
    it("should return exactly COMBAT_INPUT_SIZE floats", () => {
      const state = createMinimalGameState();
      const enemy = createEnemy();
      const result = buildCombatInput(state, enemy);

      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBe(COMBAT_INPUT_SIZE);
    });

    it("should produce values in [0, 1] range", () => {
      const state = createMinimalGameState();
      const enemy = createEnemy();
      const result = buildCombatInput(state, enemy);

      for (let i = 0; i < result.length; i++) {
        expect(result[i]).toBeGreaterThanOrEqual(0);
        expect(result[i]).toBeLessThanOrEqual(1);
      }
    });

    it("should not produce NaN for any input", () => {
      const state = createMinimalGameState();
      const enemy = createEnemy();
      // Edge case: enemy at same position (distance = 0)
      enemy.position = { ...state.self.position };
      enemy.distance = 0;

      const result = buildCombatInput(state, enemy);

      for (let i = 0; i < result.length; i++) {
        expect(Number.isNaN(result[i])).toBe(false);
        expect(Number.isFinite(result[i])).toBe(true);
      }
    });

    it("should encode enemy distance differently for near/far", () => {
      const state = createMinimalGameState();

      const nearEnemy = createEnemy();
      nearEnemy.distance = 50;
      nearEnemy.position = { x: 50, y: 0, z: 0 };

      const farEnemy = createEnemy();
      farEnemy.distance = 2000;
      farEnemy.position = { x: 2000, y: 0, z: 0 };

      const nearResult = buildCombatInput(state, nearEnemy);
      const farResult = buildCombatInput(state, farEnemy);

      // Should produce different outputs for different distances
      let different = false;
      for (let i = 0; i < COMBAT_INPUT_SIZE; i++) {
        if (Math.abs(nearResult[i] - farResult[i]) > 0.001) {
          different = true;
          break;
        }
      }
      expect(different).toBe(true);
    });
  });
});
