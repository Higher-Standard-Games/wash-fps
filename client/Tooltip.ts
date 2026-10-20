/**
 * Tooltip — the game's own tooltip in place of the browser's grey one.
 *
 * Any element with a `title` keeps working as it is: on hover or keyboard
 * focus the title moves to `data-tip` (so the browser's tooltip never shows),
 * becomes the element's `aria-description`, and appears in a small ink-and-gold
 * label under the element (above it when there is no room). Code that sets
 * `title` later is picked up on the next hover.
 */

import { UIStyles } from "../../../engine/ui/UIStyles";

const SHOW_DELAY_MS = 450;
const GAP = 8;
const MARGIN = 8;

const CSS = `
.fps-tip {
  position: fixed;
  z-index: 100001;
  max-width: min(320px, calc(100vw - 16px));
  padding: 6px 10px;
  box-sizing: border-box;
  pointer-events: none;
  color: hsl(45 100% 95%);
  font: 600 14px / 1.3 var(--w-font-body, "Rajdhani", sans-serif);
  letter-spacing: 0.02em;
  background: linear-gradient(180deg, hsl(250 38% 14% / 0.97), hsl(250 45% 8% / 0.97));
  border: 1px solid hsl(46 100% 60% / 0.5);
  border-radius: 3px;
  box-shadow: 0 8px 20px hsl(250 70% 2% / 0.5);
  opacity: 0;
  transform: translateY(-2px);
  transition: opacity 0.12s ease, transform 0.12s ease;
}
.fps-tip.is-visible {
  opacity: 1;
  transform: none;
}
@media (prefers-reduced-motion: reduce) {
  .fps-tip { transition: none; }
}
`;

let installed = false;
let tip: HTMLDivElement | null = null;
let target: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** The text to show for `el`, taking over a `title` set since the last hover. */
export function takeTitle(el: HTMLElement): string {
  const title = el.getAttribute("title");
  if (title !== null) {
    el.removeAttribute("title");
    if (title) {
      el.dataset.tip = title;
      if (!el.hasAttribute("aria-label") || el.getAttribute("aria-label") !== title)
        el.setAttribute("aria-description", title);
    } else delete el.dataset.tip;
  }
  return el.dataset.tip ?? "";
}

function tipTarget(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null;
  return node.closest<HTMLElement>("[title], [data-tip]");
}

function hide(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  target = null;
  tip?.classList.remove("is-visible");
  tip?.remove();
}

function place(el: HTMLElement): void {
  if (!tip || !el.isConnected) return hide();
  const box = el.getBoundingClientRect();
  const width = tip.offsetWidth;
  const height = tip.offsetHeight;
  const left = Math.min(Math.max(MARGIN, box.left + box.width / 2 - width / 2), window.innerWidth - width - MARGIN);
  const below = box.bottom + GAP;
  const top = below + height + MARGIN > window.innerHeight ? Math.max(MARGIN, box.top - GAP - height) : below;
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

function show(el: HTMLElement, delay: number): void {
  const text = takeTitle(el);
  if (el === target) return;
  hide();
  if (!text) return;
  target = el;
  timer = setTimeout(() => {
    timer = null;
    if (target !== el || !el.isConnected) return;
    tip ??= document.createElement("div");
    tip.className = "fps-tip";
    tip.setAttribute("role", "tooltip");
    tip.textContent = text;
    document.body.append(tip);
    place(el);
    requestAnimationFrame(() => tip?.classList.add("is-visible"));
  }, delay);
}

/** Starts replacing browser tooltips across the page. Safe to call more than once. */
export function installTooltips(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  UIStyles.injectCSS("fps-tooltip", CSS);
  document.addEventListener(
    "pointerover",
    (event) => {
      const el = tipTarget(event.target);
      if (el) show(el, SHOW_DELAY_MS);
      else if (target) hide();
    },
    true,
  );
  document.addEventListener(
    "pointerout",
    (event) => {
      if (target && !target.contains(event.relatedTarget as Node | null)) hide();
    },
    true,
  );
  document.addEventListener(
    "focusin",
    (event) => {
      const el = tipTarget(event.target);
      if (el?.matches(":focus-visible")) show(el, SHOW_DELAY_MS);
    },
    true,
  );
  document.addEventListener("focusout", () => hide(), true);
  document.addEventListener("pointerdown", () => hide(), true);
  document.addEventListener("keydown", () => hide(), true);
  window.addEventListener("scroll", () => hide(), true);
  window.addEventListener("blur", () => hide());
}
