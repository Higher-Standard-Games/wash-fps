// Extracted from FPSHud.ts

// =============================================================================
// Phase 3: Chat UI
// =============================================================================

export interface ChatMessage {
  sender: string;
  text: string;
  timestamp: number;
}

/**
 * FPSChat - In-game chat with message log and input
 *
 * Messages auto-fade after a timeout. Input is shown by pressing T/Enter.
 * Not a regular HudWidget — managed separately.
 */
export class FPSChat {
  private container: HTMLElement;
  private logEl: HTMLElement;
  private inputWrap: HTMLElement;
  private inputEl: HTMLInputElement;
  private messages: ChatMessage[] = [];
  private inputActive: boolean = false;
  private onSendCallback: ((text: string) => void) | null = null;
  private static readonly MESSAGE_FADE_MS = 8000;
  private static readonly MAX_VISIBLE = 20;

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

    this.inputEl = document.createElement("input");
    this.inputEl.className = "fps-chat-input";
    this.inputEl.type = "text";
    this.inputEl.placeholder = "Type a message...";
    this.inputEl.maxLength = 256;
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
   * Add a received message to the log
   */
  public addMessage(sender: string, text: string): void {
    const msg: ChatMessage = {
      sender,
      text,
      timestamp: performance.now(),
    };
    this.messages.push(msg);

    const el = document.createElement("div");
    el.className = "fps-chat-message";

    const senderEl = document.createElement("span");
    senderEl.className = "fps-chat-sender";
    senderEl.textContent = sender + ":";
    el.appendChild(senderEl);

    const textEl = document.createElement("span");
    textEl.textContent = text;
    el.appendChild(textEl);

    this.logEl.appendChild(el);

    // Auto-fade
    setTimeout(() => {
      el.classList.add("fps-chat-message--fading");
      setTimeout(() => el.remove(), 1000);
    }, FPSChat.MESSAGE_FADE_MS);

    // Trim excess
    while (this.logEl.children.length > FPSChat.MAX_VISIBLE) {
      this.logEl.firstChild?.remove();
    }
  }

  /**
   * Open the chat input
   */
  public openInput(): void {
    this.inputActive = true;
    this.inputWrap.classList.add("fps-chat-input-wrap--active");
    this.inputEl.value = "";
    this.inputEl.focus();
  }

  /**
   * Close the chat input
   */
  public closeInput(): void {
    this.inputActive = false;
    this.inputWrap.classList.remove("fps-chat-input-wrap--active");
    this.inputEl.blur();
  }

  public isInputActive(): boolean {
    return this.inputActive;
  }

  private handleKey(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      const text = this.inputEl.value.trim();
      if (text && this.onSendCallback) {
        this.onSendCallback(text);
      }
      this.closeInput();
      e.preventDefault();
      e.stopPropagation();
    } else if (e.key === "Escape") {
      this.closeInput();
      e.preventDefault();
      e.stopPropagation();
    }
  }

  public destroy(): void {
    this.container.remove();
  }
}
