import { describe, expect, it } from "vitest";
import { type AABB, Contents, NullCollisionWorld, type TraceResult } from "../../../../shared/collision/CollisionWorld";
import type { Vec3 } from "../../../../shared/server/simulation/types/index";
import { InputButtons, resolveDifficulty } from "../BotConfig";
import { BotGameState } from "../BotGameState";
import { BotNavGraph } from "../BotNavGraph";
import { BotSequenceRegistry, BotSequenceRuntime } from "../BotSequence";
import type { BotVision } from "../BotVision";
import { planLedgeSlideJump } from "../LedgeSlideJump";
import { StateMachineBrain } from "../StateMachineBrain";
import { LedgeSlideJumpSequence } from "../sequences/LedgeSlideJumpSequence";

class Platforms extends NullCollisionWorld {
  constructor(
    private readonly landing = true,
    private readonly lava = false,
  ) {
    super();
  }
  override stepSlideMove(start: Vec3, velocity: Vec3, dt: number, bounds: AABB) {
    const endPos = { x: start.x + velocity.x * dt, y: start.y + velocity.y * dt, z: start.z + velocity.z * dt };
    const grounded = endPos.y <= -bounds.min.y && (endPos.x <= 180 || (this.landing && endPos.x >= 360));
    if (grounded) endPos.y = -bounds.min.y;
    return { endPos, velocity: { ...velocity, y: grounded ? 0 : velocity.y }, grounded };
  }
  override trace(start: Vec3, end: Vec3, bounds?: AABB): TraceResult {
    const height = -(bounds?.min.y ?? 0);
    if (start.y >= height && end.y <= height && start.y !== end.y) {
      const fraction = (start.y - height) / (start.y - end.y);
      const x = start.x + (end.x - start.x) * fraction;
      if (x <= 180 || (this.landing && x >= 360))
        return {
          hit: true,
          fraction,
          hitPoint: { x, y: height, z: start.z + (end.z - start.z) * fraction },
          normal: { x: 0, y: 1, z: 0 },
        };
    }
    return { hit: false, fraction: 1 };
  }
  override pointContents(position: Vec3): number {
    return this.lava && position.x >= 360 ? Contents.LAVA : 0;
  }
}

function setup() {
  const state = new BotGameState();
  Object.assign(state.self, { position: { x: 0, y: 24, z: 0 }, velocity: { x: 420, y: 0, z: 0 }, isGrounded: true });
  return {
    self: state.self,
    input: {
      direction: { x: 0, y: 0, z: 1 },
      yaw: Math.PI / 2,
      pitch: 0,
      buttons: InputButtons.FORWARD | InputButtons.SPRINT,
      weaponSlot: 0,
    },
    target: { x: 500, y: 24, z: 0 },
  };
}

describe("validated slide to ledge jump", () => {
  it("starts the boost from the brain's jump route instead of a blind hop", () => {
    const { self, input, target } = setup();
    self.yaw = input.yaw;
    const state = new BotGameState();
    state.self = self;
    state.self.health = 100;
    state.pickupActiveMask = [true];
    const graph = new BotNavGraph("boost");
    graph.loadStaticData({
      nodes: [
        { id: 0, type: "spawn", position: self.position },
        { id: 1, type: "item", pickupId: 0, position: target },
      ],
      edges: [{ from: 0, to: 1, type: "jump", cost: 500 }],
    });
    const vision = {
      mapKnowledge: {
        pickupPositions: [{ id: 0, type: "armor", kind: "ra", classname: "item_armor_body", position: target }],
      },
      collisionWorld: new Platforms(),
      isWalkable: () => false,
    } as unknown as BotVision;
    const brain = new StateMachineBrain({ ...resolveDifficulty("hard"), mistakeRate: 0 });
    const result = brain.decide(state, vision, null, graph);
    expect(result.script).toBeDefined();
    expect(brain.getNavigationDebug()).toContain("sequence=ledge_slide_jump");
    expect(result.script!.some((command) => (command.buttons & InputButtons.JUMP) !== 0)).toBe(true);
  });

  it("slides, cancels into a boosted jump before the gap and lands on the far platform", () => {
    const { self, input, target } = setup();
    const plan = planLedgeSlideJump(self, input, target, new Platforms());
    expect(plan).not.toBeNull();
    expect(plan!.jumpTick).toBeGreaterThanOrEqual(14);
    expect(plan!.inputs[0].buttons & InputButtons.CROUCH).not.toBe(0);
    expect(plan!.inputs[plan!.jumpTick].buttons & InputButtons.JUMP).not.toBe(0);
    expect(plan!.takeoffSpeed).toBeGreaterThan(420);
    expect(plan!.landing.x).toBeGreaterThanOrEqual(360);
  });

  it("rejects a missing landing and a hazardous landing", () => {
    const { self, input, target } = setup();
    expect(planLedgeSlideJump(self, input, target, new Platforms(false))).toBeNull();
    expect(planLedgeSlideJump(self, input, target, new Platforms(true, true))).toBeNull();
  });

  it("rejects sideways momentum and an edge too close to establish a slide", () => {
    const { self, input, target } = setup();
    self.velocity = { x: 0, y: 0, z: 420 };
    expect(planLedgeSlideJump(self, input, target, new Platforms())).toBeNull();
    self.velocity = { x: 420, y: 0, z: 0 };
    self.position.x = 160;
    expect(planLedgeSlideJump(self, input, target, new Platforms())).toBeNull();
  });

  it("sends the proven script once, keeps moving, and confirms the actual landing", () => {
    const { self, input, target } = setup();
    const plan = planLedgeSlideJump(self, input, target, new Platforms())!;
    const registry = new BotSequenceRegistry();
    registry.register(new LedgeSlideJumpSequence());
    const runtime = new BotSequenceRuntime(registry);
    const state = new BotGameState();
    state.self = self;
    state.tick = 100;
    const context = { state, ledgeSlidePlan: plan };
    expect(runtime.startBest(context)).toBe(true);
    expect(runtime.tick(context)!.input.script).toBe(plan.inputs);
    state.tick += 2;
    const ongoing = runtime.tick(context)!;
    expect(ongoing.input.script).toBeUndefined();
    expect(ongoing.input.direction.z).toBe(1);
    state.tick = 100 + plan.inputs.length;
    state.self.position = { ...plan.landing };
    state.self.isGrounded = true;
    expect(runtime.tick(context)!.status).toBe("succeeded");
    expect(runtime.isActive).toBe(false);
  });
});
