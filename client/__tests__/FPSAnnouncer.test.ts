import { beforeEach, describe, expect, it, vi } from "vitest";

const played: string[] = [];
vi.mock("../../../../engine/AudioManager", () => ({
  AudioManager: {
    getInstance: () => ({ playSfx2D: (path: string) => played.push(path), preloadSfx: async () => {} }),
  },
}));

import { FPSAnnouncer, type MatchMoment } from "../FPSAnnouncer";
import { FPSBombAudio } from "../FPSBombAudio";
import { MatchPhase } from "../MatchStateManager";

let clock = 0;
const announcer = () => new FPSAnnouncer(() => clock);
const moment = (phase: MatchPhase, timeRemaining = 0, extra: Partial<MatchMoment> = {}): MatchMoment => ({
  phase,
  timeRemaining,
  overtime: 0,
  roundsCalledByMode: false,
  playing: true,
  ready: false,
  ...extra,
});
/** Runs `seconds` of frames at `dt`, the clock advancing with them. */
function frames(voice: FPSAnnouncer, seconds: number, at: (t: number) => MatchMoment, dt = 0.05): void {
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    voice.update(at(t), dt);
    clock += dt * 1000;
  }
}
const lines = () => played.map((path) => path.replace(/^sounds\/announcer\//, "").replace(/0?[12]?\.ogg$/, ""));

beforeEach(() => {
  played.length = 0;
  clock = 0;
});

describe("the match flow", () => {
  it("counts a three-second countdown once per number, then fight", () => {
    const voice = announcer();
    voice.update(moment(MatchPhase.Warmup), 0.05);
    frames(voice, 3, (t) => moment(MatchPhase.Countdown, 3 - t));
    voice.update(moment(MatchPhase.Active), 0.05);
    expect(lines()).toEqual(["countdown/3_", "countdown/2_", "countdown/1_", "countdown/fight"]);
  });

  it("says get ready first when the countdown leaves room before the numbers", () => {
    const voice = announcer();
    voice.update(moment(MatchPhase.Warmup), 0.05);
    frames(voice, 5, (t) => moment(MatchPhase.Countdown, 5 - t));
    expect(lines()).toEqual(["countdown/get_ready_to_fight", "countdown/3_", "countdown/2_", "countdown/1_"]);
  });

  it("leaves a mode that calls its own rounds alone, but still ends the match", () => {
    const voice = announcer();
    const bomb = { roundsCalledByMode: true };
    voice.update(moment(MatchPhase.Warmup, 0, bomb), 0.05);
    frames(voice, 3, (t) => moment(MatchPhase.Countdown, 3 - t, bomb));
    voice.update(moment(MatchPhase.Active, 0, bomb), 0.05);
    voice.update(moment(MatchPhase.PostGame, 0, bomb), 0.05);
    expect(lines()).toEqual(["postmatch/game_over"]);
  });

  it("announces each overtime, but not one already under way when joining", () => {
    const voice = announcer();
    voice.update(moment(MatchPhase.Active, 60, { overtime: 1 }), 0.05);
    voice.update(moment(MatchPhase.Active, 60, { overtime: 2 }), 0.05);
    expect(lines()).toEqual(["overtime/overtime"]);
  });

  it("reminds a player who is not ready once a minute, and nobody else", () => {
    const voice = announcer();
    frames(voice, 130, () => moment(MatchPhase.Warmup), 0.5);
    expect(lines()).toEqual(["pleasereadyup", "pleasereadyup"]);

    played.length = 0;
    const others = announcer();
    frames(others, 130, () => moment(MatchPhase.Warmup, 0, { ready: true }), 0.5);
    frames(others, 130, () => moment(MatchPhase.Warmup, 0, { playing: false }), 0.5);
    expect(played).toEqual([]);
  });
});

describe("one voice", () => {
  it("holds queued lines until the voice is free", () => {
    const voice = announcer();
    voice.queue("a.ogg");
    voice.queue("b.ogg");
    expect(played).toEqual(["a.ogg"]);
    frames(voice, 1.4, () => moment(MatchPhase.Active));
    expect(played).toEqual(["a.ogg"]);
    frames(voice, 0.2, () => moment(MatchPhase.Active));
    expect(played).toEqual(["a.ogg", "b.ogg"]);
  });
});

describe("Search and Destroy through the voice", () => {
  it("speaks each number of the freeze once, even on frames without a bomb", () => {
    const voice = announcer();
    const bomb = new FPSBombAudio(voice);
    bomb.onMatchPhase(MatchPhase.Countdown, MatchPhase.Warmup, true);
    for (let t = 3; t > 0; t -= 0.05) {
      bomb.update(null, 0.05, true);
      bomb.updateRound(MatchPhase.Countdown, t, null, true);
    }
    expect(lines()).toEqual(["bomb/offense/start", "countdown/3_", "countdown/2_", "countdown/1_"]);
  });
});
