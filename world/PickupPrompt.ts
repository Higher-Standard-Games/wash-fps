/**
 * PickupPrompt — Shared HUD prompt for weapon pickup/swap.
 * Used by both Pickup (map-spawn) and DroppedWeaponRenderer (dropped weapons).
 *
 * Only one prompt can be visible at a time (singleton element).
 * Callers set/clear via show()/hide() and track their own "isShowing" state.
 */

let promptElement: HTMLDivElement | null = null;
let currentOwner: string | null = null; // Track which system owns the prompt

function getOrCreateElement(): HTMLDivElement {
  if (!promptElement) {
    const el = document.createElement("div");
    el.id = "pickup-hud-prompt";
    el.style.cssText = `
            position: fixed;
            bottom: 25%;
            left: 50%;
            transform: translateX(-50%);
            background: linear-gradient(180deg, rgba(10,8,16,0.9) 0%, rgba(6,4,12,0.85) 100%);
            color: rgba(255, 160, 80, 1);
            font-family: 'Orbitron', 'Rajdhani', 'Inter', system-ui, sans-serif;
            font-size: 24px;
            font-weight: 700;
            letter-spacing: 0.12em;
            padding: 14px 32px;
            border: 1px solid rgba(255, 100, 0, 0.45);
            border-radius: 3px;
            pointer-events: none;
            z-index: 900;
            text-shadow: 0 0 12px rgba(255, 100, 0, 0.4), 0 0 24px rgba(255, 80, 0, 0.12);
            box-shadow: 0 0 20px rgba(255, 80, 0, 0.1), inset 0 1px 0 rgba(255, 140, 0, 0.08);
            backdrop-filter: blur(6px);
            transition: opacity 0.15s ease;
            display: none;
        `;
    document.body.appendChild(el);
    promptElement = el;
  }
  return promptElement;
}

/**
 * Show the pickup prompt with given text.
 * @param owner - Identifier for the calling system (e.g. 'pickup', 'dropped')
 * @param text - Prompt text to display
 */
export function showPickupPrompt(owner: string, text: string): void {
  const el = getOrCreateElement();
  currentOwner = owner;
  el.textContent = text;
  el.style.opacity = "1";
  el.style.display = "block";
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
