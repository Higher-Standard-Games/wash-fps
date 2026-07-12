/**
 * PickupPrompt — Shared HUD prompt for weapon pickup/swap.
 * Used by both Pickup (map-spawn) and DroppedWeaponRenderer (dropped weapons).
 *
 * Only one prompt can be visible at a time (singleton element).
 * Callers set/clear via show()/hide() and track their own "isShowing" state.
 *
 * Visual: bright Washoi cream print-slab. Any `[KEY]` token in the text renders
 * as a keycap chip, and the final word (the item name) is accented — so callers
 * just build a string like "PRESS [F] TO SWAP TO RIOTGUN" (with the key resolved
 * from the live binding via getActionKeyLabel).
 */

let promptElement: HTMLDivElement | null = null;
let currentOwner: string | null = null; // Track which system owns the prompt

function getOrCreateElement(): HTMLDivElement {
  if (!promptElement) {
    const el = document.createElement("div");
    el.id = "pickup-hud-prompt";
    el.className = "fps-pickup-prompt";
    el.style.display = "none";
    document.body.appendChild(el);
    promptElement = el;
  }
  return promptElement;
}

/** Build the print-slab content: plain text, a keycap for any `[KEY]`, and an
 *  accented final word (the item name). */
function renderPromptContent(el: HTMLElement, text: string): void {
  el.textContent = "";

  const addText = (value: string, extraClass?: string): void => {
    if (!value) return;
    const span = document.createElement("span");
    span.className = extraClass ? `fps-pickup-prompt-text ${extraClass}` : "fps-pickup-prompt-text";
    span.textContent = value;
    el.appendChild(span);
  };

  const match = text.match(/^(.*?)\[([^\]]+)\](.*)$/);
  if (!match) {
    addText(text);
    return;
  }

  const [, prefix, key, suffix] = match;
  addText(prefix);

  const keycap = document.createElement("span");
  keycap.className = "fps-keycap";
  keycap.textContent = key;
  el.appendChild(keycap);

  // Accent the final word of the suffix (the weapon/item name).
  const tail = suffix.replace(/\s+$/, "");
  const lastSpace = tail.lastIndexOf(" ");
  if (lastSpace >= 0) {
    addText(tail.slice(0, lastSpace + 1));
    addText(tail.slice(lastSpace + 1), "fps-pickup-prompt-weapon");
  } else {
    addText(tail);
  }
}

/**
 * Show the pickup prompt with given text.
 * @param owner - Identifier for the calling system (e.g. 'pickup', 'dropped')
 * @param text - Prompt text to display (may contain a `[KEY]` keycap token)
 */
export function showPickupPrompt(owner: string, text: string): void {
  const el = getOrCreateElement();
  currentOwner = owner;
  renderPromptContent(el, text);
  el.style.opacity = "1";
  // inline-block (not inline-flex): the prompt is position:fixed, so inline-flex
  // blockifies to flex, and each text span becomes a flex item whose trailing
  // whitespace is trimmed at the item's line-box edge — that ate the space in
  // "TO SWAP TO<space>PLASMAGUN". Block-level inline flow preserves it.
  el.style.display = "inline-block";
}

/**
 * Hide the pickup prompt, but only if the caller is the current owner.
 * @param owner - Must match the owner that called show()
 */
export function hidePickupPrompt(owner: string): void {
  if (currentOwner !== owner) return; // Don't hide another system's prompt
  currentOwner = null;
  if (promptElement) {
    promptElement.style.opacity = "0";
    setTimeout(() => {
      if (promptElement && !currentOwner) {
        promptElement.style.display = "none";
      }
    }, 150);
  }
}
