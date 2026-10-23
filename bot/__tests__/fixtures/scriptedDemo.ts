/**
 * A scripted match, written out as a real `.shagdemo`.
 *
 * The tests that use this could build `TrainingFrame` objects directly and run
 * far faster, but then they would prove nothing about the format: every bug
 * found in this pipeline so far lived in the seams — between the recorder and
 * the reader, between a run and the frame before it. So the fixture records
 * through the server's own recorder and the tests read the file back.
 *
 * The scripted body never moves. Velocity is zero in every snapshot, so any
 * label that says the player was walking, sprinting or jumping can only have
 * come from a recorded command — which is what these tests are checking.
 *
 * Identities are named exactly as the game server names them, because that is
 * where the worst bug in this pipeline hid. The demo roster and the recorded
 * commands use the bare player id ("1"); the snapshot keys players by the wire
 * key (`player_1`); and entity ids are wire keys of a different number. An
 * earlier version of this fixture used "1" for all three, every test passed,
 * and the extractor found nobody in a real recording.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Entity } from "../../../../../shared/net/Entity";
import { GameState, PlayerState } from "../../../../../shared/net/GameState";
import { toClientKey } from "../../../ClientEntityKey";
import { DemoRecorder } from "../../../server/DemoRecorder";
import { InputButtons } from "../../BotConfig";

/** One body in one snapshot. */
export interface Body {
  playerId: string;
  entityId: string;
  yaw: number;
  health: number;
  dead: boolean;
}

const noop = {
  serialize() {},
  deserialize() {},
  clone() {
    return { ...this };
  },
};

/**
 * The human seat: roster id "1", a verified account, and an entity whose number
 * differs from the player's, as it does on a server with anything else spawned.
 */
export const HUMAN = { playerId: "1", entityId: toClientKey(11), accountId: 41 };
/** A bot seat, with no account — nothing here should learn from it. */
export const BOT: Body = { playerId: "2", entityId: toClientKey(12), yaw: 0, health: 100, dead: false };

export function human(yaw: number, health = 100, dead = false): Body {
  return { playerId: HUMAN.playerId, entityId: HUMAN.entityId, yaw, health, dead };
}

/** One snapshot: bodies standing still, each with its combat state. */
export function snapshot(tick: number, bodies: Body[]): GameState {
  const state = new GameState();
  state.tick = tick;
  for (const body of bodies) {
    const entity = new Entity(body.entityId);
    entity.addComponent("transform", {
      position: { x: body.entityId === HUMAN.entityId ? 0 : 400, y: 0, z: 0 },
      rotation: { x: 0, y: body.yaw, z: 0, w: 1 },
      ...noop,
    } as never);
    entity.addComponent("velocity", {
      linear: { x: 0, y: 0, z: 0 },
      angular: { x: 0, y: 0, z: 0 },
      grounded: true,
      ...noop,
    } as never);
    state.entities.set(body.entityId, entity);

    // The snapshot keys a player by the wire key, not the roster id
    const player = new PlayerState();
    player.entityId = body.entityId;
    player.name = body.playerId === HUMAN.playerId ? "Person" : "Bot";
    state.players.set(toClientKey(body.playerId), player);

    state.events.push({
      type: "combat_state",
      entityId: body.entityId,
      health: body.health,
      armor: 0,
      dead: body.dead,
    });
  }
  return state;
}

/** A recorder pointed at `dir`, with the duration floor lifted. */
export function scriptedRecorder(dir: string, matchId: string): DemoRecorder {
  const recorder = new DemoRecorder({
    map: "wdm7",
    gametype: "duel",
    tickRate: 125,
    snapshotRate: 20,
    outputDir: dir,
    matchId,
    minDurationMs: 0,
  });
  recorder.addPlayer(HUMAN.playerId, "Person", "", HUMAN.accountId);
  recorder.addPlayer(BOT.playerId, "Bot", "");
  return recorder;
}

/**
 * A plain match: `frames` snapshots six ticks apart, the person walking forward
 * and turning a little each frame. Enough to train on, nothing subtle in it.
 */
export async function recordPlainMatch(dir: string, matchId: string, frames: number): Promise<string> {
  const recorder = scriptedRecorder(dir, matchId);
  for (let index = 0; index < frames; index++) {
    const tick = 6 * (index + 1);
    const yaw = 0.05 * index;
    recorder.recordInput(HUMAN.playerId, {
      buttons: index % 4 === 0 ? InputButtons.FORWARD | InputButtons.FIRE : InputButtons.FORWARD,
      yaw,
      pitch: 0,
      forward: 1,
      right: index % 3 === 0 ? 1 : 0,
      weaponSlot: 2,
    });
    recorder.recordFrame(snapshot(tick, [human(yaw), BOT]));
  }
  return recorder.stop();
}

/**
 * A corpus option that reads every map blind. The fixture's positions were made
 * up, so tracing them against a real map's walls would test the walls; and a
 * test that depends on the map files being present passes on one machine only.
 */
export const blind = { visionFor: async () => null };

/** A throwaway directory for recordings, and a way to be rid of it. */
export function demoTempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `shag-${label}-`));
}
