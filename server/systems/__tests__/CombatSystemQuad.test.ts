/**
 * CombatSystem — Quad Damage.
 *
 * The multiplier is read from the ATTACKER's powerup component inside
 * processDamage, which is the single point every damage source funnels through.
 * Scope is Q3-classic (chosen deliberately): it multiplies damage to others,
 * damage to yourself, and knockback.
 */

import { describe, expect, it } from "vitest";
import { POWERUP_DURATION_SECONDS } from "../../../../../shared/items/Powerups";
import { CombatSystem, DamageType, HitLocation } from "../CombatSystem";

const TICK_RATE = 125;
/** Comfortably beyond the tick used in these tests. */
const QUAD_UNTIL = POWERUP_DURATION_SECONDS.quad * TICK_RATE;

interface Ent {
  id: number;
  health: { health: number; armor: number; dead: boolean; maxHealth: number; maxArmor: number };
  transform: { position: { x: number; y: number; z: number } };
  physics: { velocity: { x: number; y: number; z: number } };
  powerups?: { expiry: { quad?: number } };
}

function makeEntity(id: number, quad: boolean, health = 1000): Ent {
  return {
    id,
    health: { health, armor: 0, dead: false, maxHealth: 1000, maxArmor: 100 },
    transform: { position: { x: 0, y: 0, z: 0 } },
    physics: { velocity: { x: 0, y: 0, z: 0 } },
    powerups: quad ? { expiry: { quad: QUAD_UNTIL } } : { expiry: {} },
  };
}

/** World with a distinct attacker (id 2) and victim (id 1). */
function setup(attackerHasQuad: boolean) {
  const combat = new CombatSystem();
  const impulses: { force: number }[] = [];
  combat.setMovementSubsystem({
    queueImpulse: (i: { force: number }) => impulses.push(i),
  } as never);

  const victim = makeEntity(1, false);
  const attacker = makeEntity(2, attackerHasQuad);
  const byId = new Map<number, Ent>([
    [1, victim],
    [2, attacker],
  ]);
  const state = {
    getEntityMut: (id: number) => byId.get(id),
    getEntity: (id: number) => byId.get(id),
  };
  return { combat, impulses, victim, attacker, state };
}

function hit(combat: CombatSystem, state: unknown, attackerId: number, damage: number, tick: number) {
  combat.queueDamage({
    victimId: 1 as never,
    attackerId: attackerId as never,
    damage,
    armorPiercing: 0,
    damageType: DamageType.Bullet,
    hitLocation: HitLocation.Body,
    knockbackDir: { x: 1, y: 0, z: 0 },
    knockbackScale: 10,
  });
  combat.update(state as never, 0.008, tick as never);
}

describe("CombatSystem — quad damage", () => {
  it("quadruples damage dealt to another player", () => {
    const { combat, victim, state } = setup(true);
    hit(combat, state, 2, 25, 10);
    expect(victim.health.health).toBe(1000 - 100);
  });

  it("leaves damage untouched when the attacker has no quad", () => {
    const { combat, victim, state } = setup(false);
    hit(combat, state, 2, 25, 10);
    expect(victim.health.health).toBe(1000 - 25);
  });

  it("stops multiplying the moment the quad expires", () => {
    const { combat, victim, state } = setup(true);
    // One tick past the expiry — the component still holds the tick, but the
    // rules read it as lapsed.
    hit(combat, state, 2, 25, QUAD_UNTIL + 1);
    expect(victim.health.health).toBe(1000 - 25);
  });

  it("reports the MULTIPLIED damage to the network, not the base damage", () => {
    const { combat, state } = setup(true);
    hit(combat, state, 2, 25, 10);
    const processed = combat.getProcessedDamage();
    expect(processed).toHaveLength(1);
    expect(processed[0].damage).toBe(100);
  });

  it("stacks with the headshot location multiplier", () => {
    const { combat, victim, state } = setup(true);
    combat.queueDamage({
      victimId: 1 as never,
      attackerId: 2 as never,
      damage: 10,
      armorPiercing: 0,
      damageType: DamageType.Bullet,
      hitLocation: HitLocation.Head, // 2x
      knockbackDir: { x: 1, y: 0, z: 0 },
    });
    combat.update(state as never, 0.008, 10 as never);
    // 10 base * 2 head * 4 quad = 80
    expect(victim.health.health).toBe(1000 - 80);
  });

  it("quadruples knockback too (Q3-classic scope)", () => {
    const plain = setup(false);
    hit(plain.combat, plain.state, 2, 25, 10);

    const quad = setup(true);
    hit(quad.combat, quad.state, 2, 25, 10);

    expect(plain.impulses).toHaveLength(1);
    expect(quad.impulses).toHaveLength(1);
    expect(quad.impulses[0].force).toBe(plain.impulses[0].force * 4);
  });

  it("quadruples an explicitly decoupled knockbackDamage as well", () => {
    // 0-damage shoves / instagib insta-jump set knockbackDamage directly; that
    // path bypasses finalDamage, so it needs the multiplier applied separately.
    const { combat, impulses, state } = setup(true);
    combat.queueDamage({
      victimId: 1 as never,
      attackerId: 2 as never,
      damage: 0,
      knockbackDamage: 50,
      armorPiercing: 0,
      damageType: DamageType.Explosion,
      hitLocation: HitLocation.Body,
      knockbackDir: { x: 0, y: 1, z: 0 },
      knockbackScale: 10,
    });
    combat.update(state as never, 0.008, 10 as never);
    // 50 * 4 quad * 10 scale, enemy so no self multiplier
    expect(impulses[0].force).toBe(2000);
  });
});

describe("CombatSystem — quad self-damage", () => {
  /** Attacker and victim are the SAME entity (rocket jump). */
  function selfSetup(quad: boolean) {
    const combat = new CombatSystem();
    const impulses: { force: number }[] = [];
    combat.setMovementSubsystem({
      queueImpulse: (i: { force: number }) => impulses.push(i),
    } as never);
    const player = makeEntity(1, quad);
    const state = { getEntityMut: () => player, getEntity: () => player };
    return { combat, impulses, player, state };
  }

  it("quadruples self-damage — a quad rocket jump is meant to hurt", () => {
    const withQuad = selfSetup(true);
    hit(withQuad.combat, withQuad.state, 1, 25, 10);
    expect(withQuad.player.health.health).toBe(1000 - 100);

    const without = selfSetup(false);
    hit(without.combat, without.state, 1, 25, 10);
    expect(without.player.health.health).toBe(1000 - 25);
  });

  it("still halves self-knockback, so quad scales an already-halved push", () => {
    const { combat, impulses, state } = selfSetup(true);
    hit(combat, state, 1, 25, 10);
    // finalDamage 100 * scale 10 * SELF_KB_MULTIPLIER 0.5
    expect(impulses[0].force).toBe(500);
  });
});

// ── Scoring's damage buffer ──────────────────────────────────────────

describe("CombatSystem damage accounting for scoring", () => {
  it("hands each hit to scoring exactly once", () => {
    // The bug this rules out: scoring reading `getProcessedDamage`, which
    // snapshot building clears at the SNAPSHOT rate while scoring runs every
    // tick — crediting the same hit six times over at shipped rates, and
    // without end on a server with no clients, where snapshots never build.
    const { combat, state } = setup(false);
    hit(combat, state, 2, 40, 100);

    const first = combat.drainDamageForStats();
    expect(first).toHaveLength(1);
    expect(first[0].damage).toBe(40);

    // Ticking again without new damage must credit nothing.
    combat.update(state as never, 0.008, 101 as never);
    expect(combat.drainDamageForStats()).toHaveLength(0);
  });

  it("keeps the snapshot buffer intact when scoring drains", () => {
    // The two consumers must not race: draining for score cannot cost the
    // client its damage numbers.
    const { combat, state } = setup(false);
    hit(combat, state, 2, 25, 100);

    combat.drainDamageForStats();
    expect(combat.getProcessedDamage()).toHaveLength(1);
  });
});
