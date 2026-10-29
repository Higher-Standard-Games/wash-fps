import { describe, expect, it } from "vitest";
import { DEFAULT_VIEWHEIGHT } from "../../../../engine/physics/PlayerPhysicsConstants";
import { type BotInput, BotState } from "../BotBrain";
import { type BotDifficulty, InputButtons } from "../BotConfig";
import { BotGameState, type VisiblePlayer } from "../BotGameState";
import { BotNavGraph, type NavEdgeType, type NavPath } from "../BotNavGraph";
import { getWeaponProfile } from "../BotWeaponProfile";
import { StateMachineBrain } from "../StateMachineBrain";

const difficulty: BotDifficulty = {
  aimAccuracy: 1,
  reactionTimeMs: 0,
  trackingSpeed: 999,
  predictionSkill: 1,
  itemTimingSkill: 1,
  strafeJumpSkill: 1,
  dodgeSkill: 1,
  mistakeRate: 0,
  lookAroundInterval: 10,
};

function makeEnemy(distance: number): VisiblePlayer {
  return {
    entityId: "player_2",
    playerId: "enemy",
    position: { x: 0, y: 0, z: distance },
    velocity: { x: 0, y: 0, z: 0 },
    isDead: false,
    team: "",
    relation: "enemy",
    distance,
  };
}

function makeState(overrides: Partial<BotGameState["self"]>, enemyDistance = 600): BotGameState {
  const state = new BotGameState();
  state.selfEntityId = "player_1";
  state.selfPlayerId = "bot";
  state.tick = 0;
  state.self = {
    ...state.self,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    health: 100,
    armor: 0,
    isDead: false,
    isGrounded: true,
    ...overrides,
  };
  state.players = [makeEnemy(enemyDistance)];
  return state;
}

describe("StateMachineBrain combat", () => {
  it("charges and releases the blade projectile at mid range", () => {
    const brain = new StateMachineBrain(difficulty);
    const state = makeState({ currentWeapon: "blade", weapons: ["blade"], ammo: { blade: 1 } }, 700);

    const charging = brain.decide(state);
    expect(charging.buttons & InputButtons.ALT_FIRE).not.toBe(0);
    expect(charging.buttons & InputButtons.FIRE).toBe(0);

    state.tick = 200;
    const release = brain.decide(state);
    expect(release.buttons & InputButtons.ALT_FIRE).toBe(0);
    expect(release.buttons & InputButtons.FIRE).toBe(0);

    state.tick = 201;
    const nextCharge = brain.decide(state);
    expect(nextCharge.buttons & InputButtons.ALT_FIRE).not.toBe(0);
  });

  it("swings the blade at melee range", () => {
    const brain = new StateMachineBrain(difficulty);
    const state = makeState({ currentWeapon: "blade", weapons: ["blade"], ammo: { blade: 1 } }, 80);

    const input = brain.decide(state);
    expect(input.buttons & InputButtons.FIRE).not.toBe(0);
    expect(input.buttons & InputButtons.ALT_FIRE).toBe(0);
  });

  it("fires with the weapon profile selected for this command", () => {
    const brain = new StateMachineBrain(difficulty);
    const state = makeState(
      { currentWeapon: "blade", weapons: ["blade", "machinegun"], ammo: { blade: 1, machinegun: 160 } },
      600,
    );

    const input = brain.decide(state);
    expect(input.weaponSlot).toBe(2);
    expect(input.buttons & InputButtons.FIRE).not.toBe(0);
    // The machinegun's cone tightens when aimed; the server switches before it fires
    expect(input.buttons & InputButtons.ALT_FIRE).not.toBe(0);
  });

  it("holds the electrobolt's sights until the shot counts as aimed", () => {
    const brain = new StateMachineBrain(difficulty);
    const state = makeState(
      { currentWeapon: "electrobolt", weapons: ["electrobolt"], ammo: { electrobolt: 10 } },
      1500,
    );
    const ready = getWeaponProfile("electrobolt").adsReadyTicks;

    const first = brain.decide(state);
    expect(first.buttons & InputButtons.ALT_FIRE).not.toBe(0);
    expect(first.buttons & InputButtons.FIRE).toBe(0);

    state.tick = ready - 1;
    expect(brain.decide(state).buttons & InputButtons.FIRE).toBe(0);

    state.tick = ready;
    const aimed = brain.decide(state);
    expect(aimed.buttons & InputButtons.ALT_FIRE).not.toBe(0);
    expect(aimed.buttons & InputButtons.FIRE).not.toBe(0);
  });

  it("aims hitscan fire from eye height toward the enemy origin", () => {
    const brain = new StateMachineBrain(difficulty);
    const state = makeState({ currentWeapon: "machinegun", weapons: ["machinegun"], ammo: { machinegun: 160 } }, 600);

    const input = brain.decide(state);
    expect(input.buttons & InputButtons.FIRE).not.toBe(0);
    expect(input.pitch).toBeGreaterThan(0);
    expect(input.pitch).toBeCloseTo(Math.atan2(DEFAULT_VIEWHEIGHT, 600), 3);
  });
});

describe("StateMachineBrain movement", () => {
  it("starts crouchslide while hunting at slide speed", () => {
    const brain = new StateMachineBrain(difficulty);
    const state = makeState(
      { currentWeapon: "blade", weapons: ["blade"], ammo: { blade: 1 }, velocity: { x: 0, y: 0, z: 420 } },
      600,
    );
    state.players = [];

    const input = brain.decide(state);
    expect(input.buttons & InputButtons.SPRINT).not.toBe(0);
    expect(input.buttons & InputButtons.FORWARD).not.toBe(0);
    expect(input.buttons & InputButtons.CROUCH).not.toBe(0);
    expect(brain.isSequenceActive()).toBe(true);
    expect(brain.getNavigationDebug()).toContain("sequence=route_crouchslide phase=engage");
  });

  it("continues a crouchslide and jump-cancels near the end", () => {
    const brain = new StateMachineBrain(difficulty);
    const state = makeState(
      { currentWeapon: "blade", weapons: ["blade"], ammo: { blade: 1 }, velocity: { x: 0, y: 0, z: 420 } },
      600,
    );
    state.players = [];

    brain.decide(state);
    state.tick = 5;
    state.self.isSliding = true;
    const sliding = brain.decide(state);
    expect(sliding.buttons & InputButtons.CROUCH).not.toBe(0);

    state.tick = 80;
    const input = brain.decide(state);
    expect(input.buttons & InputButtons.CROUCH).toBe(0);
    expect(input.buttons & InputButtons.JUMP).not.toBe(0);
    expect(brain.isSequenceCommitted()).toBe(true);
  });

  it("keeps walking when authoritative state does not confirm the optional slide", () => {
    const brain = new StateMachineBrain(difficulty);
    const state = makeState(
      { currentWeapon: "blade", weapons: ["blade"], ammo: { blade: 1 }, velocity: { x: 0, y: 0, z: 420 } },
      600,
    );
    state.players = [];

    brain.decide(state);
    state.tick = 20;
    const input = brain.decide(state);

    expect(brain.isSequenceActive()).toBe(false);
    expect(input.buttons & InputButtons.FORWARD).not.toBe(0);
    expect(input.buttons & InputButtons.CROUCH).toBe(0);
  });

  it("does not crouchslide while charging blade alt-fire", () => {
    const brain = new StateMachineBrain(difficulty);
    const state = makeState(
      { currentWeapon: "blade", weapons: ["blade"], ammo: { blade: 1 }, velocity: { x: 0, y: 0, z: 420 } },
      700,
    );

    const input = brain.decide(state);
    expect(input.buttons & InputButtons.ALT_FIRE).not.toBe(0);
    expect(input.buttons & InputButtons.CROUCH).toBe(0);
  });
});
type TraversalHarness = {
  currentState: BotState;
  _navGraph: BotNavGraph | null;
  _currentPath: NavPath | null;
  _blockedNavEdges: Map<string, number>;
  _blockedPickupIds: Map<number, number>;
  _tryStartItemSlideApproach: (input: BotInput, state: BotGameState) => BotInput | null;
  _getNavPathOptions: (tick: number) => { blockedEdgeKeys: ReadonlySet<string> };
  _tryStartRouteCrouchslide: (input: BotInput, state: BotGameState) => BotInput | null;
  _tryStartRouteStrafeJump: (input: BotInput, state: BotGameState) => BotInput | null;
  _tickActiveSequence: (state: BotGameState) => BotInput | null;
  _lastBotVision: {
    probeDrop: () => { safe: boolean; reason: "no_landing"; fallDistance: number; landing: null };
  } | null;
  _followCurrentPath: (
    state: BotGameState,
    urgent: boolean,
  ) => { status: "moving"; input: BotInput } | { status: "complete" } | { status: "blocked"; reason: string };
};

function makeTraversal(edgeType: NavEdgeType): { graph: BotNavGraph; path: NavPath } {
  const from = edgeType === "fall" ? { x: 0, y: 128, z: 0 } : { x: 0, y: 0, z: 0 };
  const to =
    edgeType === "teleporter"
      ? { x: 3000, y: 0, z: 0 }
      : edgeType === "jumppad"
        ? { x: 3000, y: 512, z: 0 }
        : edgeType === "fall"
          ? { x: 64, y: 0, z: 0 }
          : { x: 101, y: 50, z: 0 };
  const trigger =
    edgeType === "teleporter" || edgeType === "jumppad"
      ? {
          id: 0,
          min: { x: -20, y: -20, z: -20 },
          max: { x: 20, y: 20, z: 20 },
          dest: { ...to },
          destYaw: edgeType === "teleporter" ? 0 : undefined,
        }
      : undefined;
  const graph = new BotNavGraph("testmap");
  graph.loadStaticData({
    nodes: [
      { id: 0, type: edgeType === "teleporter" ? "teleporter" : "spawn", position: from },
      { id: 1, type: edgeType === "teleporter" ? "teleporter" : "floor", position: to },
    ],
    edges: [{ from: 0, to: 1, type: edgeType, cost: 100, trigger }],
  });
  const path = graph.findPath(from, to);
  if (!path) throw new Error("test graph did not produce a path");
  return { graph, path };
}

it("starts the specialized slide only for an active final-lane pickup", () => {
  const graph = new BotNavGraph("item-slide-test");
  graph.loadStaticData({
    nodes: [
      { id: 0, type: "spawn", position: { x: 0, y: 0, z: 0 } },
      { id: 1, type: "item", pickupId: 3, classname: "item_health", position: { x: 0, y: 0, z: 400 } },
    ],
    edges: [{ from: 0, to: 1, type: "walk", cost: 400 }],
  });
  const path = graph.findPath({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 400 });
  if (!path) throw new Error("test graph did not produce a path");

  const brain = new StateMachineBrain(difficulty) as unknown as TraversalHarness;
  brain.currentState = BotState.ITEM_RUN;
  brain._navGraph = graph;
  brain._currentPath = path;
  const state = makeState({ velocity: { x: 0, y: 0, z: 420 } });
  state.players = [];
  state.pickupActiveMask = [false, false, false, true];
  const routeInput: BotInput = {
    direction: { x: 0, y: 0, z: 1 },
    pitch: 0,
    yaw: 0,
    buttons: InputButtons.FORWARD | InputButtons.SPRINT,
    weaponSlot: 0,
  };

  const slide = brain._tryStartItemSlideApproach(routeInput, state);
  expect(slide!.buttons & InputButtons.CROUCH).not.toBe(0);
  state.tick = 105;
  state.self.isSliding = true;
  state.self.position.z = 250;
  brain._tickActiveSequence(state);
  state.tick = 125;
  state.self.position.z = 700;
  brain._tickActiveSequence(state);
  expect(brain._blockedPickupIds.has(3)).toBe(true);
  expect(brain._currentPath).toBeNull();
  state.self.position.z = 0;
  state.self.isSliding = false;

  const inactiveBrain = new StateMachineBrain(difficulty) as unknown as TraversalHarness;
  inactiveBrain.currentState = BotState.ITEM_RUN;
  inactiveBrain._navGraph = graph;
  inactiveBrain._currentPath = path;
  state.pickupActiveMask = [false, false, false, false];
  expect(inactiveBrain._tryStartItemSlideApproach(routeInput, state)).toBeNull();
});
describe("StateMachineBrain traversal executors", () => {
  it("rejects a route slide before a sharp upcoming turn", () => {
    const brain = new StateMachineBrain(difficulty);
    const state = makeState({ velocity: { x: 0, y: 0, z: 420 } });
    state.players = [];
    const start = { id: 0, type: "spawn" as const, position: { x: 0, y: 0, z: 0 } };
    const corner = { id: 1, type: "floor" as const, position: { x: 0, y: 0, z: 400 } };
    const exit = { id: 2, type: "floor" as const, position: { x: 400, y: 0, z: 400 } };
    const harness = brain as unknown as TraversalHarness;
    harness.currentState = BotState.HUNT;
    harness._currentPath = {
      nodes: [start, corner, exit],
      steps: [
        {
          from: start,
          to: corner,
          type: "walk",
          cost: 400,
          horizontalDistance: 400,
          heightDelta: 0,
          requiresPreciseApproach: false,
        },
        {
          from: corner,
          to: exit,
          type: "walk",
          cost: 400,
          horizontalDistance: 400,
          heightDelta: 0,
          requiresPreciseApproach: false,
        },
      ],
      totalCost: 800,
      cursor: 0,
    };

    const input: BotInput = {
      direction: { x: 0, y: 0, z: 1 },
      pitch: 0,
      yaw: 0,
      buttons: InputButtons.FORWARD | InputButtons.SPRINT,
      weaponSlot: 0,
    };
    expect(harness._tryStartRouteCrouchslide(input, state)).toBeNull();
    expect(brain.isSequenceActive()).toBe(false);
  });

  it("looks ahead round a corner while still walking to it", () => {
    const brain = new StateMachineBrain(difficulty);
    const state = makeState({ position: { x: 0, y: 0, z: 250 }, velocity: { x: 0, y: 0, z: 320 } });
    state.players = [];
    const start = { id: 0, type: "spawn" as const, position: { x: 0, y: 0, z: 0 } };
    const corner = { id: 1, type: "floor" as const, position: { x: 0, y: 0, z: 400 } };
    const exit = { id: 2, type: "floor" as const, position: { x: 400, y: 0, z: 400 } };
    const walk = (from: NavPath["nodes"][number], to: NavPath["nodes"][number]) => ({
      from,
      to,
      type: "walk" as const,
      cost: 400,
      horizontalDistance: 400,
      heightDelta: 0,
      requiresPreciseApproach: false,
    });
    const harness = brain as unknown as TraversalHarness;
    harness.currentState = BotState.HUNT;
    harness._navGraph = new BotNavGraph("look-ahead");
    harness._currentPath = {
      nodes: [start, corner, exit],
      steps: [walk(start, corner), walk(corner, exit)],
      totalCost: 800,
      cursor: 0,
    };

    const result = harness._followCurrentPath(state, false);
    if (result.status !== "moving") throw new Error(`expected to move, got ${result.status}`);
    // 150 units to the corner, then 100 along the next leg.
    expect(result.input.moveYaw).toBeCloseTo(0, 6);
    expect(result.input.yaw).toBeCloseTo(Math.atan2(100, 150), 6);
  });

  it("starts a pure-side strafe hop at running speed on a long straight route", () => {
    const brain = new StateMachineBrain(difficulty);
    const state = makeState({ velocity: { x: 0, y: 0, z: 400 } });
    state.players = [];
    const start = { id: 0, type: "spawn" as const, position: { x: 0, y: 0, z: 0 } };
    const end = { id: 1, type: "floor" as const, position: { x: 0, y: 0, z: 1000 } };
    const harness = brain as unknown as TraversalHarness;
    harness.currentState = BotState.HUNT;
    harness._currentPath = {
      nodes: [start, end],
      steps: [
        {
          from: start,
          to: end,
          type: "walk",
          cost: 1000,
          horizontalDistance: 1000,
          heightDelta: 0,
          requiresPreciseApproach: false,
        },
      ],
      totalCost: 1000,
      cursor: 0,
    };

    const input: BotInput = {
      direction: { x: 0, y: 0, z: 1 },
      pitch: 0,
      yaw: 0,
      buttons: InputButtons.FORWARD | InputButtons.SPRINT,
      weaponSlot: 0,
    };
    const takeoff = harness._tryStartRouteStrafeJump(input, state);
    expect(takeoff).not.toBeNull();
    expect(takeoff!.buttons & InputButtons.JUMP).not.toBe(0);
    expect(brain.getNavigationDebug()).toContain("sequence=route_strafe_jump phase=takeoff");

    state.tick = 5;
    state.self.isGrounded = false;
    state.self.velocity = { x: 0, y: 300, z: 330 };
    const airborne = harness._tickActiveSequence(state);
    expect(airborne).not.toBeNull();
    expect(airborne!.direction.z).toBe(0);
    expect(Math.abs(airborne!.direction.x)).toBe(1);
    expect(airborne!.buttons & InputButtons.FORWARD).toBe(0);
    expect(airborne!.buttons & (InputButtons.LEFT | InputButtons.RIGHT)).not.toBe(0);
  });

  it("refuses a strafe hop before a sharp turn or occupied ally corridor", () => {
    const brain = new StateMachineBrain(difficulty);
    const state = makeState({ velocity: { x: 0, y: 0, z: 320 } });
    state.players = [];
    const start = { id: 0, type: "spawn" as const, position: { x: 0, y: 0, z: 0 } };
    const corner = { id: 1, type: "floor" as const, position: { x: 0, y: 0, z: 800 } };
    const exit = { id: 2, type: "floor" as const, position: { x: 800, y: 0, z: 800 } };
    const harness = brain as unknown as TraversalHarness;
    harness.currentState = BotState.HUNT;
    harness._currentPath = {
      nodes: [start, corner, exit],
      steps: [
        {
          from: start,
          to: corner,
          type: "walk",
          cost: 800,
          horizontalDistance: 800,
          heightDelta: 0,
          requiresPreciseApproach: false,
        },
        {
          from: corner,
          to: exit,
          type: "walk",
          cost: 800,
          horizontalDistance: 800,
          heightDelta: 0,
          requiresPreciseApproach: false,
        },
      ],
      totalCost: 1600,
      cursor: 0,
    };

    const input: BotInput = {
      direction: { x: 0, y: 0, z: 1 },
      pitch: 0,
      yaw: 0,
      buttons: InputButtons.FORWARD | InputButtons.SPRINT,
      weaponSlot: 0,
    };
    expect(harness._tryStartRouteStrafeJump(input, state)).toBeNull();

    harness._currentPath = {
      nodes: [start, corner],
      steps: harness._currentPath.steps.slice(0, 1),
      totalCost: 800,
      cursor: 0,
    };
    state.players = [
      {
        entityId: "ally_entity",
        playerId: "ally",
        position: { x: 20, y: 0, z: 300 },
        velocity: { x: 0, y: 0, z: 0 },
        isDead: false,
        team: "red",
        relation: "ally",
        distance: 301,
      },
    ];
    expect(harness._tryStartRouteStrafeJump(input, state)).toBeNull();
    expect(brain.isSequenceActive()).toBe(false);
  });

  it("explicitly jumps at a jump edge takeoff", () => {
    const brain = new StateMachineBrain(difficulty);
    const state = makeState({ position: { x: 0, y: 0, z: 0 } });
    const { graph, path } = makeTraversal("jump");
    const harness = brain as unknown as TraversalHarness;
    harness._navGraph = graph;
    harness._currentPath = path;

    const result = harness._followCurrentPath(state, false);

    expect(result.status).toBe("moving");
    if (result.status === "moving") expect(result.input.buttons & InputButtons.JUMP).not.toBe(0);
    expect(brain.getNavigationDebug()).toBe("step=jump remaining=1");
  });

  it("executes cached validated jump metadata as a committed sequence", () => {
    const brain = new StateMachineBrain(difficulty);
    const state = makeState({
      position: { x: 0, y: 25, z: 0 },
      velocity: { x: 160, y: 0, z: 0 },
      currentWeapon: "blade",
      weapons: ["blade"],
      ammo: { blade: 1 },
    });
    state.players = [];
    state.tick = 100;
    const graph = new BotNavGraph("validated-jump-test");
    graph.loadStaticData({
      nodes: [
        { id: 0, type: "spawn", position: { x: 0, y: 0, z: 0 } },
        { id: 1, type: "floor", position: { x: 100, y: 0, z: 0 } },
      ],
      edges: [
        {
          from: 0,
          to: 1,
          type: "jump",
          cost: 100,
          opportunityId: "jump:0->1",
          requiredSpeed: 160,
          expectedTicks: 40,
          successMargin: 24,
          validated: true,
        },
      ],
      opportunities: [
        {
          id: "jump:0->1",
          kind: "jump",
          fromNodeId: 0,
          toNodeId: 1,
          takeoff: {
            position: { x: 0, y: 25, z: 0 },
            radius: 32,
            minSpeed: 160,
            maxSpeed: 160,
            yawRange: [Math.PI / 2 - 0.1, Math.PI / 2 + 0.1],
          },
          landing: {
            position: { x: 100, y: 25, z: 0 },
            radius: 48,
            surfaceNormal: { x: 0, y: 1, z: 0 },
          },
          inputPlan: {
            direction: { x: 1, y: 0, z: 0 },
            initialSpeed: 160,
            buttons: InputButtons.FORWARD | InputButtons.SPRINT | InputButtons.JUMP,
            jumpTicks: 1,
            maxTicks: 150,
          },
          expectedTicks: 40,
          successMargin: 24,
          risk: { fallDamage: false, requiresLedgeGrab: false },
        },
      ],
    });
    const path = graph.findPath(state.self.position, { x: 100, y: 0, z: 0 });
    if (!path) throw new Error("validated graph did not produce a path");
    const harness = brain as unknown as TraversalHarness;
    harness.currentState = BotState.HUNT;
    harness._navGraph = graph;
    harness._currentPath = path;

    const result = harness._followCurrentPath(state, false);

    expect(result.status).toBe("moving");
    if (result.status === "moving") {
      expect(result.input.buttons & InputButtons.JUMP).not.toBe(0);
      expect(result.input.yaw).toBeCloseTo(Math.PI / 2, 6);
    }
    expect(brain.isSequenceActive()).toBe(true);
    expect(brain.getNavigationDebug()).toContain("sequence=nav_validated_jump phase=takeoff");

    state.tick = 105;
    state.self.isGrounded = false;
    state.self.position = { x: 50, y: 70, z: 0 };
    const airborne = brain.decide(state, null, null, graph);
    expect(airborne.buttons & InputButtons.JUMP).toBe(0);
    expect(brain.getNavigationDebug()).toContain("phase=airborne");

    state.tick = 140;
    state.self.isGrounded = true;
    state.self.position = { x: 104, y: 25, z: 0 };
    brain.decide(state, null, null, graph);
    expect(brain.isSequenceActive()).toBe(false);
  });

  it("commits to a teleporter and verifies the non-local exit", () => {
    const brain = new StateMachineBrain(difficulty);
    const state = makeState({ position: { x: 0, y: 0, z: 0 }, yaw: 1.25 });
    state.players = [];
    const { graph, path } = makeTraversal("teleporter");
    const harness = brain as unknown as TraversalHarness;
    harness._navGraph = graph;
    harness._currentPath = path;

    const result = harness._followCurrentPath(state, false);
    expect(result.status).toBe("moving");
    if (result.status === "moving") {
      expect(result.input.buttons & InputButtons.FORWARD).not.toBe(0);
      expect(result.input.buttons & (InputButtons.JUMP | InputButtons.CROUCH)).toBe(0);
      expect(result.input.buttons & InputButtons.SPRINT).not.toBe(0);
      expect(result.input.yaw).toBe(1.25);
    }
    expect(brain.getNavigationDebug()).toContain("sequence=nav_traverse_teleporter phase=activate");

    state.tick = 5;
    state.self.position = { x: 3000, y: 25, z: 0 };
    state.self.isGrounded = false;
    harness._tickActiveSequence(state);
    graph.getNextStep(state.self.position, path);
    expect(brain.isSequenceActive()).toBe(false);
    expect(path.cursor).toBe(1);
  });

  it("confirms a jumppad launch and ballistic target", () => {
    const brain = new StateMachineBrain(difficulty);
    const state = makeState({ position: { x: 0, y: 0, z: 0 } });
    state.players = [];
    const { graph, path } = makeTraversal("jumppad");
    const harness = brain as unknown as TraversalHarness;
    harness._navGraph = graph;
    harness._currentPath = path;

    expect(harness._followCurrentPath(state, false).status).toBe("moving");
    expect(brain.getNavigationDebug()).toContain("sequence=nav_traverse_jumppad phase=activate");

    state.tick = 5;
    state.self.isGrounded = false;
    state.self.velocity = { x: 600, y: 700, z: 0 };
    state.self.position = { x: 300, y: 100, z: 0 };
    harness._tickActiveSequence(state);
    expect(brain.getNavigationDebug()).toContain("phase=airborne");

    state.tick = 70;
    state.self.position = { x: 3000, y: 512, z: 0 };
    harness._tickActiveSequence(state);
    graph.getNextStep(state.self.position, path);
    expect(brain.isSequenceActive()).toBe(false);
    expect(path.cursor).toBe(1);
  });

  it("cools down and replans after an unconfirmed teleporter activation", () => {
    const brain = new StateMachineBrain(difficulty);
    const state = makeState({ position: { x: 0, y: 0, z: 0 } });
    state.players = [];
    const { graph, path } = makeTraversal("teleporter");
    const harness = brain as unknown as TraversalHarness;
    harness.currentState = BotState.HUNT;
    harness._navGraph = graph;
    harness._currentPath = path;

    expect(harness._followCurrentPath(state, false).status).toBe("moving");
    state.tick = 40;
    harness._tickActiveSequence(state);

    expect(brain.isSequenceActive()).toBe(false);
    expect(brain.getNavigationDebug()).toBe("blocked=sequence:nav_traverse_teleporter:teleport_not_confirmed");
    expect(harness._currentPath).toBeNull();
    expect(harness._blockedNavEdges.size).toBe(1);
  });

  it("blocks a fall edge when the landing probe fails", () => {
    const brain = new StateMachineBrain(difficulty);
    const state = makeState({ position: { x: 0, y: 128, z: 0 } });
    const { graph, path } = makeTraversal("fall");
    const harness = brain as unknown as TraversalHarness;
    harness._navGraph = graph;
    harness._currentPath = path;
    harness._lastBotVision = {
      probeDrop: () => ({ safe: false, reason: "no_landing", fallDistance: 128, landing: null }),
    };

    expect(harness._followCurrentPath(state, false)).toEqual({ status: "blocked", reason: "fall:no_landing" });
    expect(brain.getNavigationDebug()).toBe("blocked=fall:no_landing");
    expect(harness._blockedNavEdges.size).toBe(1);
    expect(harness._getNavPathOptions(624).blockedEdgeKeys.size).toBe(1);
    expect(harness._getNavPathOptions(625).blockedEdgeKeys.size).toBe(0);
  });
});

// ── Holding position on an objective ─────────────────────────────────

describe("StateMachineBrain objective holding", () => {
  /**
   * A bot in a mode that cares about objectives.
   *
   * The gametype matters: with no profile, `objectivePush` is 0 and a directive
   * scores nothing — correctly, since an unknown mode should not have its bots
   * chasing orders it did not mean.
   */
  function objectiveState(position: { x: number; y: number; z: number }, radius: number, yaw = 0): BotGameState {
    const state = makeState({ position: { x: 0, y: 0, z: 0 }, yaw }, 5000);
    state.matchState = { gametypeName: "Search & Destroy", phase: 2, teamRoles: {}, roundState: "pre_plant" };
    state.directives = [orderTo(position, radius)];
    return state;
  }

  /** A directive telling the bot to be somewhere, expiring far in the future. */
  function orderTo(position: { x: number; y: number; z: number }, radius: number) {
    return {
      id: "test_hold",
      kind: "move_to" as const,
      target: { type: "position" as const, position, radius },
      priority: 0.9,
      expiresAtTick: 100_000,
      interrupt: "never" as const,
    };
  }

  it("only follows orders in a mode that has them", () => {
    // With no gametype the profile is deathmatch-shaped and objectivePush is 0,
    // so the directive scores nothing and the bot goes about its business.
    const brain = new StateMachineBrain(difficulty, "on");
    const state = makeState({ position: { x: 0, y: 0, z: 0 } }, 5000);
    state.directives = [orderTo({ x: 30, y: 0, z: 0 }, 64)];
    expect(brain.decide(state).direction).not.toEqual({ x: 0, y: 0, z: 0 });
  });

  it("stops moving once it reaches an objective", () => {
    // The behaviour objective modes are impossible without. Everything else in
    // this brain deliberately never sends a zero direction, so a bot ordered to
    // stand on a bomb would run straight past it — unable to plant (which needs
    // low speed) or arm (which needs staying in a 100-unit radius).
    const brain = new StateMachineBrain(difficulty, "on");
    const input = brain.decide(objectiveState({ x: 30, y: 0, z: 0 }, 64));
    expect(input.direction).toEqual({ x: 0, y: 0, z: 0 });
    expect(input.buttons & InputButtons.SPRINT).toBe(0);
    expect(input.buttons & InputButtons.FORWARD).toBe(0);
  });

  it("keeps running while the objective is still far away", () => {
    const brain = new StateMachineBrain(difficulty, "on");
    const input = brain.decide(objectiveState({ x: 2000, y: 0, z: 0 }, 64));
    expect(input.direction).not.toEqual({ x: 0, y: 0, z: 0 });
  });

  it("continues an uninterruptible retake instead of chasing a visible enemy", () => {
    const brain = new StateMachineBrain(difficulty, "on");
    const state = objectiveState({ x: 2000, y: 0, z: 0 }, 64);
    state.players = [makeEnemy(600)];
    state.self.health = 10;
    state.recentDamage = [
      { tick: 0, attackerId: "enemy", damage: 20, weaponId: "machinegun", position: state.self.position },
    ];
    const input = brain.decide(state);
    expect(brain.getState()).toBe(BotState.ITEM_RUN);
    expect(input.direction).not.toEqual({ x: 0, y: 0, z: 0 });
    expect(input.yaw).toBeCloseTo(Math.PI / 2);
    expect(brain.getNavigationDebug()).toContain("order=test_hold");
    state.tick++;
    state.self.position = { x: 1990, y: 0, z: 0 };
    expect(brain.decide(state).direction).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("returns to combat when a mandatory order expires", () => {
    const brain = new StateMachineBrain(difficulty, "on");
    const state = objectiveState({ x: 2000, y: 0, z: 0 }, 64);
    state.players = [makeEnemy(600)];
    brain.decide(state);
    state.tick = 100_000;
    brain.decide(state);
    expect(brain.getState()).toBe(BotState.FIGHT);
  });

  it("allows ordinary site-defense orders to engage visible attackers", () => {
    const brain = new StateMachineBrain(difficulty, "on");
    const state = objectiveState({ x: 2000, y: 0, z: 0 }, 64);
    state.players = [makeEnemy(600)];
    state.directives[0].interrupt = "enemy_visible";
    brain.decide(state);
    expect(brain.getState()).toBe(BotState.FIGHT);
  });

  it("faces what it came for rather than freezing its view", () => {
    // A fixed stare reads as a hung bot, and a planted bomb is worth watching.
    const brain = new StateMachineBrain(difficulty, "on");
    const input = brain.decide(objectiveState({ x: 0, y: 0, z: 40 }, 64, 3));
    expect(input.yaw).toBeCloseTo(0, 2); // atan2(0, 40) — looking down +z
  });
});

describe("StateMachineBrain site patrol", () => {
  function harness() {
    const brain = new StateMachineBrain(difficulty);
    const graph = new BotNavGraph("site-patrol-test");
    graph.loadStaticData({
      nodes: [
        { id: 0, type: "floor", position: { x: 180, y: -24, z: 0 } },
        { id: 1, type: "floor", position: { x: -180, y: -24, z: 0 } },
        { id: 2, type: "floor", position: { x: 900, y: -24, z: 0 } },
        { id: 3, type: "floor", position: { x: 0, y: 176, z: 0 } },
      ],
      edges: [],
    });
    const h = brain as unknown as {
      _navGraph: BotNavGraph;
      _lastBotVision: {
        isWalkable: (from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) => boolean;
      };
      _navigateGoal: (state: BotGameState, goal: import("../goals/BotGoal").BotGoal, urgent: boolean) => BotInput;
      _sitePatrol: { target: { x: number; y: number; z: number } } | null;
    };
    h._navGraph = graph;
    h._lastBotVision = { isWalkable: () => true };
    const state = makeState({}, 5000);
    const goal: import("../goals/BotGoal").BotGoal = {
      id: "objective:siteA",
      kind: "defend",
      position: { x: 0, y: 0, z: 0 },
      radius: 384,
      directive: {
        id: "siteA",
        kind: "defend",
        target: { type: "position", position: { x: 0, y: 0, z: 0 }, radius: 384 },
        priority: 0.8,
        expiresAtTick: 10000,
        interrupt: "enemy_visible",
      },
    };
    return { h, state, goal };
  }
  it("patrols supported positions inside the site, pauses, then chooses another point", () => {
    const { h, state, goal } = harness();
    const walking = h._navigateGoal(state, goal, false);
    expect(walking.direction.z).toBe(1);
    expect(walking.buttons & (InputButtons.JUMP | InputButtons.CROUCH)).toBe(0);
    expect(walking.buttons & InputButtons.SPRINT).not.toBe(0);
    const first = { ...h._sitePatrol!.target };
    expect(Math.abs(first.x)).toBe(180);
    expect(first.y).toBe(0);
    state.self.position = first;
    state.tick = 1;
    expect(h._navigateGoal(state, goal, false).buttons).toBe(0);
    state.tick = 127;
    expect(h._navigateGoal(state, goal, false).direction.z).toBe(1);
    expect(h._sitePatrol!.target.x).toBe(-first.x);
  });
  it("holds when no safe walk exists, rather than walking through a wall or pit", () => {
    const { h, state, goal } = harness();
    h._lastBotVision.isWalkable = () => false;
    expect(h._navigateGoal(state, goal, false).buttons).toBe(0);
    expect(h._sitePatrol).toBeNull();
  });
  it("stops patrolling when the order changes to planting or defusing", () => {
    const { h, state, goal } = harness();
    h._navigateGoal(state, goal, false);
    goal.directive!.kind = "move_to";
    goal.kind = "move_to";
    expect(h._navigateGoal(state, goal, true).buttons).toBe(0);
    expect(h._sitePatrol).toBeNull();
  });
});
