import type { DemoEventKind, DemoEventTimeline } from "./DemoEventTimeline";

/** Lightweight demo-only event presentation driven entirely by DemoEventTimeline. */
export class DemoEventOverlay {
  private readonly root: HTMLElement;
  private readonly feed: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly notice: HTMLElement;

  constructor(
    private readonly timeline: DemoEventTimeline,
    doc: Document = document,
  ) {
    this.root = doc.createElement("div");
    this.root.className = "demo-event-overlay";
    Object.assign(this.root.style, {
      position: "fixed",
      inset: "0",
      zIndex: "9100",
      pointerEvents: "none",
      color: "white",
      fontFamily: "Arial, sans-serif",
      textShadow: "0 2px 4px #000, 0 0 8px #000",
    });

    this.feed = doc.createElement("div");
    Object.assign(this.feed.style, {
      position: "absolute",
      top: "72px",
      right: "24px",
      display: "flex",
      flexDirection: "column",
      alignItems: "flex-end",
      gap: "6px",
      fontSize: "16px",
    });

    this.banner = doc.createElement("div");
    Object.assign(this.banner.style, {
      position: "absolute",
      top: "15%",
      left: "50%",
      transform: "translateX(-50%)",
      color: "#ffd54a",
      fontSize: "30px",
      fontWeight: "bold",
      textAlign: "center",
    });

    this.notice = doc.createElement("div");
    Object.assign(this.notice.style, {
      position: "absolute",
      bottom: "24%",
      left: "50%",
      transform: "translateX(-50%)",
      fontSize: "20px",
      fontWeight: "bold",
      textAlign: "center",
    });

    this.root.append(this.feed, this.banner, this.notice);
    doc.body.appendChild(this.root);
    this.render();
  }

  add(kind: DemoEventKind, text: string, durationMs: number): boolean {
    const added = this.timeline.push(kind, text, durationMs);
    if (added) this.render();
    return added;
  }

  render(): void {
    const entries = this.timeline.getEntries();
    const feedEntries = entries.filter(
      (entry) => entry.kind === "chat" || entry.kind === "kill" || entry.kind === "award",
    );
    this.feed.replaceChildren(...feedEntries.slice(-6).map((entry) => this.makeLine(entry.kind, entry.text)));

    const banner = [...entries].reverse().find((entry) => entry.kind === "banner");
    this.banner.textContent = banner?.text ?? "";

    const notice = [...entries].reverse().find((entry) => entry.kind === "pickup" || entry.kind === "damage");
    this.notice.textContent = notice?.text ?? "";
    this.notice.style.color = notice?.kind === "damage" ? "#ff5a5a" : "#ffffff";
  }

  show(): void {
    this.root.style.display = "";
  }

  hide(): void {
    this.root.style.display = "none";
  }

  destroy(): void {
    this.root.remove();
  }

  private makeLine(kind: DemoEventKind, text: string): HTMLElement {
    const line = this.root.ownerDocument.createElement("div");
    line.textContent = text;
    if (kind === "award") line.style.color = "#ffd54a";
    else if (kind === "chat") line.style.color = "#d8efff";
    return line;
  }
}
