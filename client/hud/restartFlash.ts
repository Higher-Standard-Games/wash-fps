/**
 * Replay a one-shot CSS flash on a HUD element without forcing a layout.
 *
 * The usual trick (remove the class, read `offsetWidth`, add it back) makes the
 * browser lay out the whole page on the spot, right after the widget wrote its
 * new numbers. The ammo counter did that on every shot of a machinegun. Here a
 * flash already playing is rewound through the Web Animations API instead,
 * which needs at most a style pass, and the class is dropped when the flash
 * ends so the next one can start by simply adding it again.
 *
 * `cls` is the class to show, `group` every class that shares the flash slot
 * (one is shown at a time), and `names` the @keyframes those classes run.
 */
const armed = new WeakSet<HTMLElement>();

export function restartFlash(el: HTMLElement, cls: string, group: readonly string[], names: readonly string[]): void {
  if (!armed.has(el)) {
    armed.add(el);
    el.addEventListener("animationend", (event) => {
      if (names.includes(event.animationName)) el.classList.remove(...group);
    });
  }
  const wasShown = el.classList.contains(cls);
  for (const other of group) if (other !== cls) el.classList.remove(other);
  el.classList.add(cls);

  let rewound = false;
  for (const animation of el.getAnimations?.({ subtree: true }) ?? []) {
    const name = (animation as Animation & { animationName?: string }).animationName;
    if (name !== undefined && names.includes(name)) {
      animation.currentTime = 0;
      animation.play();
      rewound = true;
    }
  }
  // Nothing to rewind, yet the class was already on: the last flash ended
  // without its end event (the HUD was hidden, say). Restart it the old way.
  if (!rewound && wasShown) {
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }
}
