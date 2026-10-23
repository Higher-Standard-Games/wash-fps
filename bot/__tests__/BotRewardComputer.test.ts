import { describe, expect, it } from "vitest";
import type { TrainingFrame } from "../BotEpisodeRecorder";
import { BotRewardComputer, DEFAULT_REWARDS } from "../BotRewardComputer";

// ── Helpers ─────────────────────────────────────────────────────────

function createFrame(overrides: Partial<TrainingFrame> = {}): TrainingFrame {
  return {
    tick: 0,
    tacticalInput: new Array(25).fill(0.5),
    combatInput: null,
    action: {
      buttons: 0,
      weaponSlot: 1,
      yaw: 0,
      pitch: 0,
      directionX: 0,
      directionZ: 1,
    },
    events: {
      damageDealt: 0,
      damageTaken: 0,
      kill: false,
      death: false,
      itemPickedUp: false,
      healthBefore: 100,
      healthAfter: 100,
      armorBefore: 0,
      armorAfter: 0,
    },
    reward: 0,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("BotRewardComputer", () => {
  describe("computeRewards", () => {
    it("should not crash on empty frames", () => {
      const computer = new BotRewardComputer();
      computer.computeRewards([]);
      // No error = pass
    });

    it("should assign survival bonus to neutral frames", () => {
      const computer = new BotRewardComputer();
      const frames = [createFrame({ tick: 1 }), createFrame({ tick: 2 })];

      computer.computeRewards(frames);

      expect(frames[0].reward).toBe(DEFAULT_REWARDS.survivalBonus);
      expect(frames[1].reward).toBe(DEFAULT_REWARDS.survivalBonus);
    });

    it("should assign positive reward for kills", () => {
      const computer = new BotRewardComputer();
      const frames = [
        createFrame({ tick: 1 }),
        createFrame({
          tick: 2,
          events: { ...createFrame().events, kill: true },
        }),
      ];

      computer.computeRewards(frames);

      expect(frames[1].reward).toBeGreaterThan(frames[0].reward);
      expect(frames[1].reward).toBeGreaterThanOrEqual(DEFAULT_REWARDS.killReward);
    });

    it("should assign negative reward for deaths", () => {
      const computer = new BotRewardComputer();
      const frames = [
        createFrame({ tick: 1 }),
        createFrame({
          tick: 2,
          events: { ...createFrame().events, death: true },
        }),
      ];

      computer.computeRewards(frames);

      expect(frames[1].reward).toBeLessThan(0);
    });

    it("should propagate kill reward backward with decay", () => {
      const computer = new BotRewardComputer();
      const frames: TrainingFrame[] = [];

      // 10 neutral frames, then a kill
      for (let i = 0; i < 10; i++) {
        frames.push(createFrame({ tick: i }));
      }
      frames.push(
        createFrame({
          tick: 10,
          events: { ...createFrame().events, kill: true },
        }),
      );

      computer.computeRewards(frames);

      // Frame 9 (just before kill) should get more reward than frame 0
      expect(frames[9].reward).toBeGreaterThan(frames[0].reward);

      // Frame 10 (kill frame) should have the highest reward
      expect(frames[10].reward).toBeGreaterThan(frames[9].reward);
    });

    it("should assign positive reward for item pickups", () => {
      const computer = new BotRewardComputer();
      const neutral = createFrame({ tick: 1 });
      const pickup = createFrame({
        tick: 2,
        events: {
          ...createFrame().events,
          itemPickedUp: true,
          healthBefore: 80,
          healthAfter: 100,
        },
      });

      computer.computeRewards([neutral, pickup]);

      expect(pickup.reward).toBeGreaterThan(neutral.reward);
    });
  });

  describe("normalizeRewards", () => {
    it("should normalize to [-1, 1] range", () => {
      const computer = new BotRewardComputer();
      const frames = [
        createFrame({ tick: 1 }),
        createFrame({
          tick: 2,
          events: { ...createFrame().events, kill: true },
        }),
        createFrame({
          tick: 3,
          events: { ...createFrame().events, death: true },
        }),
      ];

      computer.computeRewards(frames);
      computer.normalizeRewards(frames);

      for (const frame of frames) {
        expect(frame.reward).toBeGreaterThanOrEqual(-1);
        expect(frame.reward).toBeLessThanOrEqual(1);
      }
    });

    it("should zero out rewards when all are equal", () => {
      const computer = new BotRewardComputer();
      const frames = [createFrame({ tick: 1 }), createFrame({ tick: 2 })];

      computer.computeRewards(frames);
      computer.normalizeRewards(frames);

      // All frames had identical rewards (survival bonus only)
      // so normalization should zero them
      for (const frame of frames) {
        expect(frame.reward).toBe(0);
      }
    });
  });

  describe("getStats", () => {
    it("should return zeros for empty frames", () => {
      const computer = new BotRewardComputer();
      const stats = computer.getStats([]);

      expect(stats.totalReward).toBe(0);
      expect(stats.avgReward).toBe(0);
      expect(stats.minReward).toBe(0);
      expect(stats.maxReward).toBe(0);
    });

    it("should compute correct statistics", () => {
      const computer = new BotRewardComputer();
      const frames = [createFrame({ reward: -1 }), createFrame({ reward: 0 }), createFrame({ reward: 1 })];

      const stats = computer.getStats(frames);

      expect(stats.totalReward).toBe(0);
      expect(stats.avgReward).toBe(0);
      expect(stats.minReward).toBe(-1);
      expect(stats.maxReward).toBe(1);
    });
  });
});
