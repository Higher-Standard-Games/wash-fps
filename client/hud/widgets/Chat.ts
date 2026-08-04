/**
 * FPSChat — in-game chat (Warsow/Q3 messagemode style).
 *
 * Two presentations of ONE message store (cap 100):
 *  - Closed: the last few messages float as an overlay and fade out.
 *  - Talk mode (T): the panel expands into a scrollable print-slab HISTORY
 *    dialog showing everything buffered; Enter sends (server round-trip, no
 *    local echo), Esc cancels. Pointer lock stays held — mouse look keeps
 *    working; game binds are suppressed by the InputSystem text-field guard.
 *
 * Messages arrive via the `chat` snapshot event (GameEvents / DemoService),
 * so live play and demo playback share this widget unchanged.
 */

export interface ChatMessage {
  sender: string;
  text: string;
  /** Server team id ("udon" / "soba" / "spectator" / "") — colors the sender stamp. */
  team: string;
  timestamp: number;
}

export class FPSChat {
  private container: HTMLElement;
  private logEl: HTMLElement;
  private inputWrap: HTMLElement;
  private inputEl: HTMLInputElement;
  private messages: ChatMessage[] = [];
  /** The viewer's own side, so a sender can be coloured ally or enemy. */
  private localTeam: string = "";
  private inputActive: boolean = false;
  private onSendCallback: ((text: string) => void) | null = null;

  private static readonly MESSAGE_FADE_MS = 8000;
  /** Messages visible in the closed overlay. */
  private static readonly MAX_VISIBLE = 5;
  /** Total history buffer (talk-mode scrollback). */
  private static readonly HISTORY_MAX = 100;

  constructor() {
    this.container = document.createElement("div");
    this.container.className = "fps-chat";

    // Message log
    this.logEl = document.createElement("div");
    this.logEl.className = "fps-chat-log";
    this.container.appendChild(this.logEl);

    // Input area
    this.inputWrap = document.createElement("div");
    this.inputWrap.className = "fps-chat-input-wrap";

    const prompt = document.createElement("span");
    prompt.className = "fps-chat-prompt";
    prompt.textContent = "SAY";
    this.inputWrap.appendChild(prompt);

    this.inputEl = document.createElement("input");
    this.inputEl.className = "fps-chat-input";
    this.inputEl.type = "text";
    this.inputEl.placeholder = "Enter to send · Esc to cancel";
    this.inputEl.maxLength = 128;
    this.inputWrap.appendChild(this.inputEl);

    this.container.appendChild(this.inputWrap);
    document.body.appendChild(this.container);

    // Input event handlers
    this.inputEl.addEventListener("keydown", (e) => this.handleKey(e));
  }

  /**
   * Set callback for when a message is sent
   */
  public onSend(callback: (text: string) => void): void {
    this.onSendCallback = callback;
  }

  /**
   * Add a received message to the store + render it in the current mode.
   */
  /** Tell the log which side the viewer is on, so senders colour correctly. */
  public setLocalTeam(team: string): void {
    this.localTeam = team ?? "";
  }

  public addMessage(sender: string, text: string, team: string = ""): void {
    const msg: ChatMessage = { sender, text, team, timestamp: performance.now() };
    this.messages.push(msg);
    if (this.messages.length > FPSChat.HISTORY_MAX) {
      this.messages.shift();
    }

    // Talk mode shows everything (no fade); closed mode fades + trims.
    this.logEl.appendChild(this.renderMessage(msg, !this.inputActive));
    if (this.inputActive) {
      this.logEl.scrollTop = this.logEl.scrollHeight;
    } else {
      while (this.logEl.children.length > FPSChat.MAX_VISIBLE) {
        this.logEl.firstChild?.remove();
      }
    }
  }

  private renderMessage(msg: ChatMessage, withFade: boolean): HTMLElement {
    const el = document.createElement("div");
    el.className = "fps-chat-message";

    const senderEl = document.createElement("span");
    senderEl.className = "fps-chat-sender";
    // Allegiance, not team name — a teammate's name is the ally colour whichever
    // side you are on this half.
    if (msg.team === "spectator") senderEl.classList.add("fps-chat-sender--spec");
    else if (msg.team && this.localTeam && msg.team === this.localTeam) senderEl.classList.add("fps-chat-sender--ally");
    else if (msg.team) senderEl.classList.add("fps-chat-sender--enemy");
    senderEl.textContent = msg.sender;
    el.appendChild(senderEl);

    const textEl = document.createElement("span");
    textEl.className = "fps-chat-text";
    textEl.textContent = msg.text; // textContent — renderer-side XSS safety
    el.appendChild(textEl);

    if (withFade) {
      const remaining = Math.max(0, FPSChat.MESSAGE_FADE_MS - (performance.now() - msg.timestamp));
      setTimeout(() => {
        el.classList.add("fps-chat-message--fading");
        setTimeout(() => el.remove(), 1000);
      }, remaining);
    }
    return el;
  }

  /** Re-render the log for the current mode (full history vs recent overlay). */
  private rebuildLog(): void {
    this.logEl.innerHTML = "";
    const source = this.inputActive ? this.messages : this.messages.slice(-FPSChat.MAX_VISIBLE);
    for (const msg of source) {
      // Closed mode: skip messages whose fade window already passed.
      if (!this.inputActive && performance.now() - msg.timestamp >= FPSChat.MESSAGE_FADE_MS) continue;
      this.logEl.appendChild(this.renderMessage(msg, !this.inputActive));
    }
    if (this.inputActive) {
      this.logEl.scrollTop = this.logEl.scrollHeight;
    }
  }

  /**
   * Open talk mode: expand to the scrollable history dialog + focus the input.
   */
  public openInput(): void {
    this.inputActive = true;
    this.container.classList.add("fps-chat--history");
    this.inputWrap.classList.add("fps-chat-input-wrap--active");
    this.rebuildLog();
    this.inputEl.value = "";
    this.inputEl.focus();
  }

  /**
   * Close talk mode: collapse back to the fading overlay.
   */
  public closeInput(): void {
    this.inputActive = false;
    this.container.classList.remove("fps-chat--history");
    this.inputWrap.classList.remove("fps-chat-input-wrap--active");
    this.inputEl.blur();
    this.rebuildLog();
  }

  public isInputActive(): boolean {
    return this.inputActive;
  }

  public show(): void {
    this.container.style.display = "";
  }

  public hide(): void {
    this.container.style.display = "none";
  }

  private handleKey(e: KeyboardEvent): void {
    // Keystrokes belong to the input while typing — never the game.
    e.stopPropagation();
    if (e.key === "Enter") {
      const text = this.inputEl.value.trim();
      if (text && this.onSendCallback) {
        this.onSendCallback(text);
      }
      this.closeInput();
      e.preventDefault();
    } else if (e.key === "Escape") {
      this.closeInput();
      e.preventDefault();
    }
  }

  public destroy(): void {
    this.container.remove();
  }
}
