import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MatchRunnerPool, type RunnerBotEvents } from "../runner/MatchRunnerPool";

const fake = fileURLToPath(new URL("./fixtures/fake-runner.mjs", import.meta.url));
const pool = () => new MatchRunnerPool({ file: process.execPath, args: [fake] });

function recorder(log: string[], name: string): RunnerBotEvents {
  return {
    onReference: (reference) => log.push(`${name} reference ${reference.preset}`),
    onReport: () => log.push(`${name} report`),
    onDisconnected: () => log.push(`${name} disconnected`),
  };
}

const exited = async (runners: MatchRunnerPool) => {
  for (let i = 0; i < 100 && runners.status().length > 0; i++) await new Promise((r) => setTimeout(r, 20));
  return runners.status().length === 0;
};

describe("match runners", () => {
  it("plays one game server's bots in one runner, and another's in another", async () => {
    const runners = pool();
    const log: string[] = [];
    const a = await runners.launch("ws://a", { name: "A1", difficulty: "medium" }, undefined, recorder(log, "A1"));
    const a2 = await runners.launch("ws://a", { name: "A2", difficulty: "medium" }, "ticket", recorder(log, "A2"));
    const b = await runners.launch("ws://b", { name: "B1", difficulty: "medium" }, undefined, recorder(log, "B1"));
    expect([a.playerId, a2.playerId, b.playerId]).toEqual(["player_1", "player_2", "player_1"]);
    const status = runners.status();
    expect(status.map((s) => [s.serverUrl, s.bots])).toEqual([
      ["ws://a", ["A1", "A2"]],
      ["ws://b", ["B1"]],
    ]);
    expect(status[0].pid).not.toBe(status[1].pid);
    expect(log).toEqual(["A1 reference medium", "A2 reference medium", "B1 reference medium"]);
    await runners.stop();
    expect(await exited(runners)).toBe(true);
    expect(log.slice(3).sort()).toEqual(["A1 disconnected", "A2 disconnected", "B1 disconnected"]);
  });

  it("fails a bot the runner refuses, and the runner ends with its last bot", async () => {
    const runners = pool();
    const log: string[] = [];
    await expect(
      runners.launch("ws://a", { name: "Refused", difficulty: "medium" }, undefined, recorder(log, "Refused")),
    ).rejects.toThrow("refused");
    const bot = await runners.launch("ws://a", { name: "A1", difficulty: "medium" }, undefined, recorder(log, "A1"));
    await bot.dispose();
    expect(await exited(runners)).toBe(true);
    // A bot disposed by its seat is not reported back as disconnected.
    expect(log).toEqual(["A1 reference medium"]);
  });

  it("starts a new runner for a bot that reaches one as it ends", async () => {
    const runners = pool();
    const log: string[] = [];
    const first = await runners.launch("ws://a", { name: "A1", difficulty: "medium" }, undefined, recorder(log, "A1"));
    const firstPid = runners.status()[0].pid;
    // The runner's last bot leaves, and the next match on the same address seats a bot at once
    await first.dispose();
    const next = await runners.launch("ws://a", { name: "A2", difficulty: "medium" }, undefined, recorder(log, "A2"));
    expect(next.playerId).toBe("player_1");
    const status = runners.status();
    expect(status.map((s) => s.bots)).toEqual([["A2"]]);
    expect(status[0].pid).not.toBe(firstPid);
    await runners.stop();
    expect(await exited(runners)).toBe(true);
  });
});
