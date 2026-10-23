import { describe, expect, it } from "vitest";
import type { CollisionWorld } from "../../../../engine/network/systems/collision/CollisionWorld";
import type { IComponent } from "../../../../shared/net/Component";
import { Entity } from "../../../../shared/net/Entity";
import { GameState, PlayerState } from "../../../../shared/net/GameState";
import { InputButtons } from "../BotConfig";
import { applyFriendlyFireSafety } from "../BotFireSafety";
import { BotGameState, type VisiblePlayer } from "../BotGameState";
import { BotVision, type MapKnowledgeData } from "../BotVision";

function player(entityId: string, team: string): PlayerState {
  const value = new PlayerState();
  value.entityId = entityId;
  value.team = team;
  return value;
}

function entity(id: string, x: number, z: number): Entity {
  const value = new Entity(id);
  value.addComponent("transform", {
    position: { x, y: 0, z },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  } as unknown as IComponent);
  value.addComponent("velocity", {
    linear: { x: 0, y: 0, z: 0 },
    grounded: true,
  } as unknown as IComponent);
  value.addComponent("movementState", {
    isSliding: id === "self-entity",
    isCrouching: id === "self-entity",
  } as unknown as IComponent);
  return value;
}

function perceivedPlayer(relation: "ally" | "enemy", x: number, z: number): VisiblePlayer {
  return {
    entityId: `${relation}-entity`,
    playerId: `${relation}-player`,
    position: { x, y: 0, z },
    velocity: { x: 0, y: 0, z: 0 },
    isDead: false,
    team: relation === "ally" ? "blue" : "red",
    relation,
    distance: Math.hypot(x, z),
  };
}

const collision = {
  trace: () => ({ hit: false, fraction: 1 }),
  pointContents: () => 0,
} as unknown as CollisionWorld;

const mapKnowledge: MapKnowledgeData = {
  mapName: "test",
  mapFingerprint: "test-fingerprint",
  spawnPoints: [],
  triggerVolumes: [],
  pickupPositions: [
    { id: 0, classname: "item_health_small", type: "health", kind: "small", position: { x: 10, y: 0, z: 0 } },
    { id: 1, classname: "item_health_mega", type: "health", kind: "mega", position: { x: 100, y: 0, z: 0 } },
    { id: 2, classname: "ammo_rockets", type: "ammo", kind: "rockets", position: { x: 20, y: 0, z: 0 } },
  ],
};

describe("sound investigation", () => {
  it("chases a newly heard enemy and keeps investigating continuous footsteps", () => {
    const vision = new BotVision(collision, { ...mapKnowledge, pickupPositions: [] });
    const state = new BotGameState();
    state.heardEnemies = [perceivedPlayer("enemy", 0, -300)];
    for (const tick of [100, 102, 104]) {
      state.tick = tick;
      const result = vision.getVisibleState(state);
      expect(result.visibleEnemies).toHaveLength(0);
      expect(result.chaseTarget?.playerId).toBe("enemy-player");
      expect(result.chaseTarget?.predictedPosition).toEqual({ x: 0, y: 0, z: -300 });
    }
  });

  it("predicts one second of lost visual contact using the server tick rate", () => {
    const vision = new BotVision(collision, { ...mapKnowledge, pickupPositions: [] });
    const state = new BotGameState();
    const enemy = perceivedPlayer("enemy", 0, 300);
    enemy.velocity = { x: 125, y: 0, z: 0 };
    state.tick = 100;
    state.players = [enemy];
    vision.getVisibleState(state);
    state.tick = 225;
    state.players = [];
    const result = vision.getVisibleState(state);
    expect(result.chaseTarget?.predictedPosition.x).toBeCloseTo(125);
  });
});

describe("bot team perception", () => {
  it('counts everyone as an enemy in a free-for-all, where the server calls every team "spectator"', () => {
    // The server has no team to name in a free-for-all and sends "spectator" for
    // everyone; its own damage rule and broadcaster read that as "no team". The
    // bot read it as a shared team, so in Deathmatch every other player — bots
    // and people alike — was an ally, and nobody was ever a target.
    const snapshot = new GameState();
    snapshot.tick = 1;
    snapshot.players.set("self", player("self-entity", "spectator"));
    snapshot.players.set("other", player("other-entity", "spectator"));
    snapshot.entities.set("self-entity", entity("self-entity", 0, 0));
    snapshot.entities.set("other-entity", entity("other-entity", 0, 100));

    const state = new BotGameState();
    state.selfEntityId = "self-entity";
    state.selfPlayerId = "self";
    state.update(snapshot);

    expect(state.players.map((seen) => seen.relation)).toEqual(["enemy"]);
    expect(state.getNearestEnemy()?.entityId).toBe("other-entity");
    expect(state.getAllies()).toEqual([]);
  });

  it("derives allies and enemies from the snapshot and copies pickup availability", () => {
    const snapshot = new GameState();
    snapshot.tick = 42;
    snapshot.pickupActiveMask = [true, false, true];
    snapshot.players.set("self", player("self-entity", "blue"));
    snapshot.players.set("ally", player("ally-entity", "blue"));
    snapshot.players.set("enemy", player("enemy-entity", "red"));
    snapshot.entities.set("self-entity", entity("self-entity", 0, 0));
    snapshot.entities.set("ally-entity", entity("ally-entity", 0, 10));
    snapshot.entities.set("enemy-entity", entity("enemy-entity", 0, 100));

    const state = new BotGameState();
    state.selfEntityId = "self-entity";
    state.selfPlayerId = "self";
    state.update(snapshot);

    expect(state.self.team).toBe("blue");
    expect(state.self.isSliding).toBe(true);
    expect(state.self.isCrouching).toBe(true);
    expect(state.getAllies().map((entry) => entry.playerId)).toEqual(["ally"]);
    expect(state.getNearestEnemy()?.playerId).toBe("enemy");
    expect(state.lastKnownEnemyPositions.has("ally")).toBe(false);
    expect(state.lastKnownEnemyPositions.has("enemy")).toBe(true);
    expect(state.pickupActiveMask).toEqual([true, false, true]);
  });

  it("keeps mutable vision memory per bot while sharing map geometry", () => {
    const template = new BotVision(collision, mapKnowledge, false);
    const first = template.fork();
    const second = template.fork();

    first.registerSoundEvent("enemy", "enemy-entity", { x: 1, y: 2, z: 3 }, 10);

    expect(first.collisionWorld).toBe(second.collisionWorld);
    expect(first.mapKnowledge).toBe(second.mapKnowledge);
    expect(first.getEnemyTracks().has("enemy")).toBe(true);
    expect(second.getEnemyTracks().has("enemy")).toBe(false);
  });

  it("excludes allies from vision targets and inactive pickups from navigation", () => {
    const state = new BotGameState();
    state.tick = 1;
    state.players = [perceivedPlayer("ally", 0, 50), perceivedPlayer("enemy", 0, 100)];
    const vision = new BotVision(collision, mapKnowledge, false);

    const result = vision.getVisibleState(state);

    expect(result.visibleEnemies.map((entry) => entry.player.playerId)).toEqual(["enemy-player"]);
    expect(vision.findNearestItem(state.self.position, "health", [false, true, true])).toEqual({ x: 100, y: 0, z: 0 });
    expect(vision.findNearestItem(state.self.position, "ammo", [true, true, true])).toEqual({ x: 20, y: 0, z: 0 });
  });
});

describe("friendly-fire safety", () => {
  const firingInput = {
    direction: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    buttons: InputButtons.FIRE | InputButtons.ALT_FIRE,
    weaponSlot: 0,
  };

  it("suppresses attacks when a living ally intersects the aim ray", () => {
    const state = new BotGameState();
    state.players = [perceivedPlayer("ally", 0, 100)];

    const result = applyFriendlyFireSafety(firingInput, state);

    expect(result.suppressed).toBe(true);
    expect(result.blockingAlly?.playerId).toBe("ally-player");
    expect(result.input.buttons & (InputButtons.FIRE | InputButtons.ALT_FIRE)).toBe(0);
  });

  it("does not suppress attacks when allies are clear of the aim ray", () => {
    const state = new BotGameState();
    state.players = [perceivedPlayer("ally", 100, 100)];

    const result = applyFriendlyFireSafety(firingInput, state);

    expect(result.suppressed).toBe(false);
    expect(result.input).toBe(firingInput);
  });
});

describe("drop probing", () => {
  it("accepts a clear drop with a standable landing", () => {
    const dropCollision = {
      trace: (
        start: { x: number; y: number; z: number },
        end: { x: number; y: number; z: number },
        bounds?: unknown,
      ) => {
        if (bounds) return { hit: false, fraction: 1 };
        return {
          hit: true,
          fraction: 0.5,
          hitPoint: { x: end.x, y: 0, z: end.z },
          start,
        };
      },
      pointContents: () => 0,
    } as unknown as CollisionWorld;
    const vision = new BotVision(dropCollision, mapKnowledge, false);

    expect(vision.probeDrop({ x: 0, y: 128, z: 0 }, { x: 64, y: 0, z: 0 })).toMatchObject({
      safe: true,
      reason: "safe",
      fallDistance: 128,
    });
  });

  it("rejects a drop when no landing surface is found", () => {
    const vision = new BotVision(collision, mapKnowledge, false);

    expect(vision.probeDrop({ x: 0, y: 128, z: 0 }, { x: 64, y: 0, z: 0 })).toMatchObject({
      safe: false,
      reason: "no_landing",
    });
  });
});
