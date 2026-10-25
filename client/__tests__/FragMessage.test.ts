// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { HUDState, KillFeedEntry } from "../HUDState";
import { FPSFragMessage } from "../hud/widgets/FragMessage";

function frag(seq: number, over: Partial<KillFeedEntry> = {}): KillFeedEntry {
  return {
    victimId: `player_${seq + 10}`,
    killerId: "player_2",
    victimName: `Bot ${seq}`,
    killerName: "Me",
    weaponId: "rail",
    byLocal: true,
    ofLocal: false,
    byViewed: true,
    ofViewed: false,
    seq,
    timestamp: 0,
    ...over,
  };
}

const hud = (killFeed: KillFeedEntry[]) => ({ killFeed }) as unknown as HUDState;
const messages = (widget: FPSFragMessage) =>
  [...widget.getElement().querySelectorAll(".fps-frag-message")].map((node) => node.textContent);

describe("frag message", () => {
  it("confirms a frag you took, by the victim's name", () => {
    const widget = new FPSFragMessage();
    widget.update(hud([]));
    widget.update(hud([frag(1)]));
    expect(messages(widget)).toEqual(["FRAGGED Bot 1"]);
  });

  it("says nothing of other players' frags, or of your own death", () => {
    const widget = new FPSFragMessage();
    widget.update(hud([]));
    widget.update(hud([frag(1, { byViewed: false }), frag(2, { byViewed: true, ofViewed: true })]));
    expect(messages(widget)).toEqual([]);
  });

  it("keeps confirming once the capped feed stops growing", () => {
    const widget = new FPSFragMessage();
    const feed = [1, 2, 3, 4, 5].map((seq) => frag(seq, { byViewed: false }));
    widget.update(hud(feed));

    // The feed holds five: a new frag pushes the oldest out, and its length stays 5
    widget.update(hud([...feed.slice(1), frag(6)]));
    expect(messages(widget)).toEqual(["FRAGGED Bot 6"]);
  });

  it("confirms the frags of the player a demo or spectator follows", () => {
    const widget = new FPSFragMessage();
    widget.update(hud([]));
    widget.update(hud([frag(1, { byLocal: false, byViewed: true })]));
    expect(messages(widget)).toEqual(["FRAGGED Bot 1"]);
  });

  it("does not replay frags that were in the feed before it was looking", () => {
    const widget = new FPSFragMessage();
    widget.update(hud([frag(1)]));
    expect(messages(widget)).toEqual([]);
  });
});
