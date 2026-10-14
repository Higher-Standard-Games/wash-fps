/**
 * FPSChat — in-game chat: a message line opened with a key, over the game.
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
  /** From the game rather than a player: no sender stamp. */
  notice?: boolean;
  playerName?: string;
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
  private onSendCallback: ((text: string, teamOnly?: boolean) => void) | null = null;
  private readonly mutedNames = new Set<string>();
  private teamInput = false;
  private prompt: HTMLElement;

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
    this.prompt = prompt;
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
  public onSend(callback: (text: string, teamOnly?: boolean) => void): void {
    this.onSendCallback = callback;
  }

  /**
   * Add a received message to the store + render it in the current mode.
   */
  /** Tell the log which side the viewer is on, so senders colour correctly. */
  public setLocalTeam(team: string): void {
    this.localTeam = team ?? "";
  }

  public addMessage(sender: string, text: string, team: string = "", playerName = sender): void {
    if (this.mutedNames.has(playerName.trim().toLowerCase())) return;
    this.push({ sender, text, team, playerName, timestamp: performance.now() });
  }

  public clearMutes(): void {
    this.mutedNames.clear();
  }

  private localCommand(text: string): boolean {
    const match = text.match(/^\/(mute|unmute)(?:\s+(.*))?$/i);
    if (!match) return false;
    const name = (match[2] ?? "").trim().replace(/^"(.*)"$/, "$1");
    const key = name.toLowerCase();
    if (!key) {
      this.addNotice(`Usage: /${match[1].toLowerCase()} <playername>`);
      return true;
    }
    if (match[1].toLowerCase() === "mute") {
      this.mutedNames.add(key);
      this.messages = this.messages.filter(
        (message) => message.notice || message.playerName?.trim().toLowerCase() !== key,
      );
      this.rebuildLog();
      this.addNotice(`Muted ${name} for this match. Use /unmute ${name} to undo.`);
    } else {
      this.addNotice(this.mutedNames.delete(key) ? `Unmuted ${name}.` : `${name} is not muted.`);
    }
    return true;
  }

  private push(msg: ChatMessage): void {
    this.messages.push(msg);
    if (this.messages.length > FPSChat.HISTORY_MAX) {
      this.messages.shift();
    }

    // Talk mode shows everything (no fade); closed mode fades + trims.
    const following = this.logEl.scrollHeight - this.logEl.scrollTop - this.logEl.clientHeight < 40;
    const previousTop = this.logEl.scrollTop;
    this.logEl.appendChild(this.renderMessage(msg, !this.inputActive));
    if (this.inputActive) {
      const heightBeforeTrim = this.logEl.scrollHeight;
      while (this.logEl.children.length > FPSChat.HISTORY_MAX) this.logEl.firstChild?.remove();
      this.logEl.scrollTop = following
        ? this.logEl.scrollHeight
        : Math.max(0, previousTop - (heightBeforeTrim - this.logEl.scrollHeight));
    } else {
      while (this.logEl.children.length > FPSChat.MAX_VISIBLE) {
        this.logEl.firstChild?.remove();
      }
    }
  }

  /** A line from the game rather than a player, such as why a join was refused. */
  public addNotice(text: string): void {
    this.push({ sender: "", text, team: "", timestamp: performance.now(), notice: true });
  }

  private renderMessage(msg: ChatMessage, withFade: boolean): HTMLElement {
    const el = document.createElement("div");
    el.className = "fps-chat-message";

    if (msg.notice) {
      el.classList.add("fps-chat-message--notice");
    } else {
      const senderEl = document.createElement("span");
      senderEl.className = "fps-chat-sender";
      // Allegiance, not team name — a teammate's name is the ally colour whichever
      // side you are on this half.
      if (msg.team === "spectator") senderEl.classList.add("fps-chat-sender--spec");
      else if (msg.team && this.localTeam && msg.team === this.localTeam)
        senderEl.classList.add("fps-chat-sender--ally");
      else if (msg.team) senderEl.classList.add("fps-chat-sender--enemy");
      senderEl.textContent = msg.sender;
      el.appendChild(senderEl);
    }

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
  public openInput(teamOnly = false): void {
    if (teamOnly && this.localTeam !== "udon" && this.localTeam !== "soba") {
      this.addNotice("Team chat is only available to players on a team.");
      return;
    }
    this.teamInput = teamOnly;
    this.prompt.textContent = teamOnly ? "TEAM" : "SAY";
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
    // 229 covers composition-ending key events that some IMEs report without isComposing.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      const text = this.inputEl.value.trim();
      if (text && !this.localCommand(text) && this.onSendCallback) {
        const teamCommand = text.match(/^\/say_team(?:\s+(.*))?$/i);
        if (teamCommand) {
          const message = (teamCommand[1] ?? "").trim();
          if (message) this.onSendCallback(message, true);
          else this.addNotice("Usage: /say_team <message>");
        } else if (this.teamInput) this.onSendCallback(text, true);
        else this.onSendCallback(text);
      }
      this.closeInput();
      e.preventDefault();
    } else if (e.key === "Escape") {
      this.closeInput();
      e.preventDefault();
    }
  }

  public destroy(): void {
    this.clearMutes();
    this.container.remove();
  }
}
