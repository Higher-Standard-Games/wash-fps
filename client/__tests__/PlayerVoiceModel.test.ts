import { afterEach, describe, expect, it } from "vitest";
import { Cvar } from "../../../../engine/core/Cvar";
import type { GameState } from "../../../../engine/network/core/GameState";
import { encodeLook, LOOK_MODELS } from "../../shared/players/PlayerLook";
import { playerVoiceForEntity } from "../FPSPlayerAudio";
import { MatchStateManager } from "../MatchStateManager";
import { registerPlayerModelSelection } from "../PlayerModelSelection";
import { RemotePlayerRenderer } from "../RemotePlayerRenderer";

const FEMALE = encodeLook(LOOK_MODELS.indexOf("female"), 0);
const ROBOT = encodeLook(LOOK_MODELS.indexOf("robot"), 1);

afterEach(() => {
  Cvar.reset("cl_team_ally_model");
  Cvar.reset("cl_team_enemy_model");
  MatchStateManager.getInstance().reset();
});

function renderer(ownEntityId: string | null, perspectiveEntityId: string | null = null) {
  return Object.assign(Object.create(RemotePlayerRenderer.prototype), {
    looks: new Map([
      ["me", FEMALE],
      ["them", ROBOT],
    ]),
    teams: new Map(),
    localTeam: null,
    ownEntityId,
    perspectiveEntityId,
  }) as { voiceFor(entityId: string): string; modelChoiceFor(entityId: string): string };
}

const matchState = (teamBased: boolean) =>
  MatchStateManager.getInstance().processEvent({ type: "match_state", teamBased } as never);

describe("a player's voice follows their model", () => {
  it("in a free-for-all, you are the body the server gave you, and sound like it", () => {
    registerPlayerModelSelection();
    matchState(false);
    const live = renderer("me");
    expect(live.modelChoiceFor("water-local-body")).toBe("female");
    expect(live.voiceFor("me")).toBe("female");
    expect(live.voiceFor("them")).toBe("bobot");
    // A demo following you shows the same body
    expect(renderer(null, "me").modelChoiceFor("me")).toBe("female");
  });

  it("in team modes, your settings choose the body and its voice", () => {
    registerPlayerModelSelection();
    Cvar.set("cl_team_ally_model", "robot");
    Cvar.set("cl_team_enemy_model", "riotkitty");
    matchState(true);
    const live = renderer("me");
    expect(live.voiceFor("me")).toBe("bobot");
    expect(live.voiceFor("them")).toBe("female");
  });

  it("without a renderer, your own sounds still take the assigned voice", () => {
    registerPlayerModelSelection();
    const state = {
      players: new Map([["p1", { entityId: "me", team: "", look: FEMALE }]]),
    } as unknown as GameState;
    expect(playerVoiceForEntity(state, "me", "me")).toBe("female");
  });
});
