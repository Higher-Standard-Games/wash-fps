/**
 * Liquid state as the simulation sees it.
 *
 * Pure data and pure functions: no Babylon, no ECS, no rendering. The server,
 * the predicted client and the tests all share this definition, which is what
 * lets a swimmer reconcile instead of jitter.
 */

export type LiquidKind = "water" | "slime" | "lava";

/**
 * How deep a player is, Q3's four-state ladder.
 *
 * 0 — dry.
 * 1 — feet wet; still walking, with wading friction.
 * 2 — waist deep; swimming.
 * 3 — fully submerged; swimming, and the air timer runs.
 */
export type WaterLevel = 0 | 1 | 2 | 3;

export interface LiquidSample {
  level: WaterLevel;
  /** The dominant liquid at the feet, or null when dry. */
  kind: LiquidKind | null;
  /**
   * Contents at the foot probe — Q3's `watertype`. Preserved raw rather than
   * reduced to `kind`, because a brush can be several liquids at once and a
   * later rule may need the bits `kind` discarded.
   */
  rawContents: number;
  footContents: number;
  waistContents: number;
  eyeContents: number;
}

export const DRY_SAMPLE: Readonly<LiquidSample> = Object.freeze({
  level: 0,
  kind: null,
  rawContents: 0,
  footContents: 0,
  waistContents: 0,
  eyeContents: 0,
});

/**
 * What changed between two consecutive samples.
 *
 * These are the moments worth reacting to — a splash, an audio crossfade, a
 * gasp — and they are derived rather than stored, so nothing has to remember
 * whether it already fired.
 */
export interface LiquidTransitions {
  /** Dry to wet: the body broke the surface. */
  entered: boolean;
  /** Wet to dry: the body left the liquid entirely. */
  exited: boolean;
  /** Reached level 3: the head went under. */
  headUnder: boolean;
  /** Dropped below level 3 while still in liquid, or left it: the head is out. */
  headClear: boolean;
}

export function liquidTransitions(previous: LiquidSample, current: LiquidSample): LiquidTransitions {
  const wasIn = previous.level > 0;
  const isIn = current.level > 0;
  const wasUnder = previous.level === 3;
  const isUnder = current.level === 3;

  return {
    entered: !wasIn && isIn,
    exited: wasIn && !isIn,
    headUnder: !wasUnder && isUnder,
    headClear: wasUnder && !isUnder,
  };
}

/** Level 2 and 3 swim; level 1 wades with the normal ground/air branch. */
export function isSwimming(level: WaterLevel): boolean {
  return level >= 2;
}

/**
 * How much of a landing impact survives the liquid that broke it.
 *
 * Q3's values: ankle-deep halves the fall, waist-deep quarters it, and a fully
 * submerged player takes none. Applied to the landing delta, not to velocity,
 * so it composes with whatever fall model is in use.
 */
export function fallDamageScale(level: WaterLevel): number {
  switch (level) {
    case 0:
      return 1;
    case 1:
      return 0.5;
    case 2:
      return 0.25;
    default:
      return 0;
  }
}
