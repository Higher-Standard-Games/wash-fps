import { describe, expect, it } from "vitest";
import { installMatchSettings, type MatchSettingsPanel } from "../MatchSettings";
import { NativeBridge } from "../NativeBridge";

class FakePanel implements MatchSettingsPanel {
  opened: string[] = [];
  open = false;
  private closed: (() => void) | null = null;
  openWith(kicker: string): void {
    this.opened.push(kicker);
    this.open = true;
  }
  onClose(callback: () => void): void {
    this.closed = callback;
  }
  isOpen(): boolean {
    return this.open;
  }
  close(): void {
    this.open = false;
    this.closed?.();
  }
}

function setup() {
  const sent: Record<string, unknown>[] = [];
  const bridge = new NativeBridge({
    __washoiNative: { shell: "washoi-native", capabilities: [] },
    ipc: { postMessage: (text: string) => sent.push(JSON.parse(text)) },
    location: { pathname: "/client" },
  } as never);
  const panels: FakePanel[] = [];
  installMatchSettings(bridge, () => {
    const panel = new FakePanel();
    panels.push(panel);
    return panel;
  });
  return { bridge, sent, panels };
}

describe("installMatchSettings", () => {
  it("says the page can show the settings over a match", () => {
    const { sent, panels } = setup();
    expect(sent.map((m) => m.type)).toEqual(["settings:ready"]);
    expect(panels).toHaveLength(0);
  });

  it("opens the settings named for the match and says when they close", () => {
    const { bridge, sent, panels } = setup();
    bridge.receive({ v: 1, type: "settings:open", kicker: "Duel · dm2" });
    bridge.receive({ v: 1, type: "settings:open", kicker: "Duel · dm2" });
    expect(panels).toHaveLength(1);
    expect(panels[0].opened).toEqual(["Duel · dm2"]);
    panels[0].close();
    expect(sent.map((m) => m.type)).toEqual(["settings:ready", "settings:closed"]);
    // Opened again, the same panel.
    bridge.receive({ v: 1, type: "settings:open" });
    expect(panels).toHaveLength(1);
    expect(panels[0].opened).toEqual(["Duel · dm2", ""]);
  });
});
