/**
 * ClientSilenceMonitor: a client whose messages stop while its connection stays
 * open is named once, and named again when it is heard from.
 */

import { describe, expect, it } from "vitest";
import { ClientSilenceMonitor } from "../ClientSilenceMonitor";

describe("ClientSilenceMonitor", () => {
  it("reports a client once when its messages stop", () => {
    const monitor = new ClientSilenceMonitor(2000);
    const human = { id: "ws-1", lastMessageAt: 1000 };
    const bot = { id: "ws-2", lastMessageAt: 3900 };

    expect(monitor.check([human, bot], 2500)).toEqual({ stalled: [], resumed: [] });
    expect(monitor.check([human, bot], 4000)).toEqual({ stalled: [{ id: "ws-1", silentMs: 3000 }], resumed: [] });
    expect(monitor.check([human, bot], 9000).stalled).toEqual([{ id: "ws-2", silentMs: 5100 }]);
  });

  it("reports how long it was silent when it is heard from again", () => {
    const monitor = new ClientSilenceMonitor(2000);
    const human = { id: "ws-1", lastMessageAt: 1000 };
    monitor.check([human], 4000);

    human.lastMessageAt = 12000;

    expect(monitor.check([human], 12010)).toEqual({ stalled: [], resumed: [{ id: "ws-1", silentMs: 11000 }] });
    expect(monitor.check([human], 13000)).toEqual({ stalled: [], resumed: [] });
  });

  it("forgets a silent client that has left, so a reused id starts fresh", () => {
    const monitor = new ClientSilenceMonitor(2000);
    monitor.check([{ id: "ws-1", lastMessageAt: 0 }], 5000);

    monitor.check([], 6000);

    expect(monitor.check([{ id: "ws-1", lastMessageAt: 6500 }], 7000)).toEqual({ stalled: [], resumed: [] });
  });
});
