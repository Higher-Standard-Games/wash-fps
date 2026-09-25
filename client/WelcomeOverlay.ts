/**
 * WelcomeOverlay — the first thing a new player sees: a name, or the key they
 * already have. The lobby has already made them an account by now, so the name
 * screen renames it and "Use my key" swaps it for the one the key opens.
 *
 * The gold panel is the rail before it has a menu in it: it shrinks to the
 * rail's width as the lobby takes over.
 */

import { createRaisedKey } from "../../../engine/ui/components/RaisedKey";
import { UIStyles } from "../../../engine/ui/UIStyles";
import { currentIdentity, LoginError, renameAccount, renameFailureText } from "../../../lobby/AccountSession";
import { KEY_LENGTH } from "../../../lobby/PlayerIdentity";
import { switchFpsAccount } from "./FpsLobbyService";
import { createSlot, judgeName, type Slot, wireKeySlot } from "./IdentityFields";
import { buildIdentityFrame, identityScreen, narrowOntoRail } from "./IdentityFrame";
import identityCSSRaw from "./styles/Identity.css?raw";

export class WelcomeOverlay {
  readonly root: HTMLElement;
  private readonly onDone: () => void;
  private ghostEl!: HTMLElement;
  private nameScreen!: HTMLFormElement;
  private restoreScreen!: HTMLFormElement;
  private nameSlot!: Slot;
  private nameKey!: HTMLButtonElement;
  private keySlot!: Slot;
  private keyKey!: HTMLButtonElement;
  private leaving = false;

  /** `onDone` runs once the overlay is gone and the lobby is the player's again. */
  constructor(onDone: () => void) {
    UIStyles.injectCSS("lobby-identity", identityCSSRaw);
    this.onDone = onDone;
    this.root = this.build();
  }

  private build(): HTMLElement {
    const frame = buildIdentityFrame("Welcome", "HELLO");
    this.ghostEl = frame.ghost;
    frame.inner.append(this.buildNameScreen(), this.buildRestoreScreen());
    return frame.root;
  }

  private buildNameScreen(): HTMLFormElement {
    const form = identityScreen("Welcome", "Who are you?");
    this.nameSlot = createSlot({
      id: "welcome-name",
      label: "Your player name",
      placeholder: "Your name",
      maxLength: 16,
      counted: true,
      say: "2–16 characters: letters, numbers, _ and -",
    });
    this.nameKey = createRaisedKey({ label: "Play →", hint: "That's it", variants: ["ink", "go"] });
    this.nameKey.type = "submit";

    const row = document.createElement("div");
    row.className = "welcome__go";
    const note = document.createElement("span");
    note.className = "welcome__note";
    note.append("No email.", document.createElement("br"), "No password.");
    row.append(this.nameKey, note);

    const alt = document.createElement("div");
    alt.className = "welcome__alt";
    alt.append("Played before?");
    const restore = createRaisedKey({ label: "Use my key", variants: ["sm", "cream", "inline"] });
    restore.addEventListener("click", () => this.show("restore"));
    alt.appendChild(restore);

    this.nameSlot.input.addEventListener("input", () => {
      const typed = this.nameSlot.input.value.trim();
      const verdict = judgeName(typed);
      this.nameSlot.tell(typed ? verdict.text : this.keepName(), typed ? verdict.tone : "");
      this.nameKey.disabled = typed !== "" && !verdict.ok;
      this.ghostEl.textContent = typed.toUpperCase() || "HELLO";
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.takeName();
    });

    form.append(this.nameSlot.root, row, alt);
    this.nameScreen = form;
    return form;
  }

  private buildRestoreScreen(): HTMLFormElement {
    const form = identityScreen("Welcome back", "Paste your key", "Your name comes back with it.");
    this.keySlot = createSlot({
      id: "welcome-key",
      label: "Your player key",
      placeholder: "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX",
      prefix: "WASHOI-",
      say: `${KEY_LENGTH} characters. Dashes and spaces don't matter.`,
    });
    this.keyKey = createRaisedKey({ label: "Restore →", hint: "Back to it", variants: ["ink", "go"] });
    this.keyKey.type = "submit";
    this.keyKey.disabled = true;
    wireKeySlot(this.keySlot, (_key, whole) => {
      this.keyKey.disabled = !whole;
    });

    const row = document.createElement("div");
    row.className = "welcome__go";
    row.appendChild(this.keyKey);

    const alt = document.createElement("div");
    alt.className = "welcome__alt";
    alt.append("New here?");
    const pick = createRaisedKey({ label: "Pick a name", variants: ["sm", "cream", "inline"] });
    pick.addEventListener("click", () => this.show("name"));
    alt.appendChild(pick);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.useKey();
    });
    form.append(this.keySlot.root, row, alt);
    form.hidden = true;
    this.restoreScreen = form;
    return form;
  }

  /** The name the lobby already gave this browser, kept if the player types nothing. */
  private keepName(): string {
    const name = currentIdentity()?.name;
    return name ? `Leave it empty to play as ${name}` : "2–16 characters: letters, numbers, _ and -";
  }

  private show(screen: "name" | "restore"): void {
    this.nameScreen.hidden = screen !== "name";
    this.restoreScreen.hidden = screen !== "restore";
    this.ghostEl.textContent = screen === "restore" ? "AGAIN" : this.nameSlot.input.value.toUpperCase() || "HELLO";
    const slot = screen === "restore" ? this.keySlot : this.nameSlot;
    if (screen === "name") this.nameSlot.tell(this.keepName());
    slot.input.focus();
  }

  /** Put the overlay on `parent` and ask the first question. */
  open(parent: HTMLElement): void {
    parent.appendChild(this.root);
    this.show("name");
  }

  private async takeName(): Promise<void> {
    const name = this.nameSlot.input.value.trim();
    if (!name) {
      this.leave();
      return;
    }
    if (!judgeName(name).ok) return;
    this.nameKey.disabled = true;
    this.nameSlot.tell("Asking the lobby…");
    const outcome = await renameAccount(name);
    if (outcome.ok) {
      this.ghostEl.textContent = outcome.identity.name.toUpperCase();
      this.leave();
      return;
    }
    this.nameSlot.tell(renameFailureText(outcome.code), "bad");
    this.nameKey.disabled = false;
  }

  private async useKey(): Promise<void> {
    this.keyKey.disabled = true;
    this.keySlot.tell("Asking the lobby…");
    try {
      const welcome = await switchFpsAccount(this.keySlot.input.value);
      const name = welcome.identity?.name ?? "player";
      this.keySlot.tell(`Welcome back, ${name}`, "ok");
      this.ghostEl.textContent = name.toUpperCase();
      setTimeout(() => this.leave(), 600);
    } catch (err) {
      const text =
        err instanceof LoginError
          ? err.code === "unknown_key"
            ? "No player has that key. Check it, or pick a name"
            : "Too many tries. Wait a minute, then try again"
          : "The lobby didn't answer. Try again";
      this.keySlot.tell(text, "bad");
      this.keyKey.disabled = false;
    }
  }

  /** The panel narrows to the rail, then the lobby underneath is the player's. */
  private leave(): void {
    if (this.leaving) return;
    this.leaving = true;
    narrowOntoRail(this.root, this.onDone);
  }

  destroy(): void {
    this.leaving = true;
    this.root.remove();
  }
}
