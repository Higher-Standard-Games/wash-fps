/**
 * The name and key fields the Welcome screen and the Profile page share:
 * a slot cut into the surface, a line that says how it's going, and the
 * judgements the lobby will make, made here first.
 */

import { checkPlayerName, KEY_LENGTH, keyCharacters, NAME_PATTERN } from "../../../lobby/PlayerIdentity";

export type SayTone = "" | "ok" | "bad";

export interface Slot {
  root: HTMLElement;
  input: HTMLInputElement;
  say: HTMLElement;
  /** Say how it's going: plain, good, or wrong. */
  tell(text: string, tone?: SayTone): void;
  /** Fill the slot from elsewhere, counter and all. */
  setValue(value: string): void;
}

/** A slot for typing into, with its own status line underneath. */
export function createSlot(options: {
  id: string;
  label: string;
  placeholder?: string;
  prefix?: string;
  maxLength?: number;
  counted?: boolean;
  say: string;
}): Slot {
  const root = document.createElement("div");
  root.className = "identity-slot";

  const box = document.createElement("label");
  box.className = `identity-slot__box${options.prefix ? " identity-slot__box--key" : ""}`;
  box.htmlFor = options.id;

  if (options.prefix) {
    const prefix = document.createElement("span");
    prefix.className = "identity-slot__prefix";
    prefix.textContent = options.prefix;
    box.appendChild(prefix);
  }

  const input = document.createElement("input");
  input.id = options.id;
  input.type = "text";
  input.className = "identity-slot__input";
  input.placeholder = options.placeholder ?? "";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.setAttribute("aria-label", options.label);
  input.setAttribute("aria-describedby", `${options.id}-say`);
  if (options.maxLength) input.maxLength = options.maxLength;
  // Typing here must not reach the game's key bindings
  input.addEventListener("keydown", (event) => event.stopPropagation());
  box.appendChild(input);

  let count: HTMLElement | null = null;
  if (options.counted && options.maxLength) {
    count = document.createElement("span");
    count.className = "identity-slot__count";
    count.textContent = `0 / ${options.maxLength}`;
    box.appendChild(count);
    input.addEventListener("input", () => {
      if (count) count.textContent = `${input.value.trim().length} / ${options.maxLength}`;
    });
  }

  const say = document.createElement("p");
  say.className = "identity-say";
  say.id = `${options.id}-say`;
  say.setAttribute("role", "status");
  say.textContent = options.say;

  root.append(box, say);
  return {
    root,
    input,
    say,
    tell(text, tone = "") {
      say.className = `identity-say${tone ? ` identity-say--${tone}` : ""}`;
      say.textContent = text;
    },
    setValue(value) {
      input.value = value;
      if (count && options.maxLength) count.textContent = `${value.trim().length} / ${options.maxLength}`;
    },
  };
}

/** What to say about a name the player is typing, and whether it can be sent. */
export function judgeName(name: string): { ok: boolean; text: string; tone: SayTone } {
  if (!name) return { ok: false, text: "2–16 characters: letters, numbers, _ and -", tone: "" };
  if (!NAME_PATTERN.test(name)) {
    return name.length < 2
      ? { ok: false, text: "One more character", tone: "" }
      : { ok: false, text: "Letters, numbers, _ and - only", tone: "bad" };
  }
  if (checkPlayerName(name) === "name_reserved") {
    return { ok: false, text: `${name} is kept for bots and new players`, tone: "bad" };
  }
  return { ok: true, text: `${name} looks good`, tone: "ok" };
}

/**
 * Keep a key slot tidy as it's typed: canonical characters in groups of four,
 * and a count until the key is whole. Calls `onChange` with the key so far.
 */
export function wireKeySlot(slot: Slot, onChange: (key: string, whole: boolean) => void): void {
  slot.input.addEventListener("input", () => {
    const key = keyCharacters(slot.input.value);
    const groups = key.match(/.{1,4}/g) ?? [];
    slot.input.value = groups.join("-");
    const whole = key.length === KEY_LENGTH;
    slot.tell(whole ? "That's a whole key" : `${key.length} / ${KEY_LENGTH} characters`, whole ? "ok" : "");
    onChange(key, whole);
  });
}
