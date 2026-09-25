/**
 * The frame the Welcome and Profile screens share: the gold panel — the rail
 * widened to hold one question at a time — beside a dark stage with its light
 * and backdrop word. It opens by widening out of the rail and closes by
 * narrowing back onto it.
 */

const MOVE_MS = 720;

export interface IdentityFrame {
  /** The whole overlay: put it on the lobby panel. */
  root: HTMLElement;
  /** Where the screens go, under the logo. */
  inner: HTMLElement;
  /** The dark side, for anything that sits beside the panel. */
  stage: HTMLElement;
  /** The word written huge and hollow across the stage. */
  ghost: HTMLElement;
}

export function buildIdentityFrame(label: string, ghostText: string): IdentityFrame {
  const root = document.createElement("div");
  root.className = "welcome";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", label);

  const panel = document.createElement("section");
  panel.className = "welcome__panel";
  const kanji = document.createElement("div");
  kanji.className = "welcome__kanji";
  kanji.setAttribute("aria-hidden", "true");
  kanji.textContent = "名";
  const inner = document.createElement("div");
  inner.className = "welcome__inner";

  const logo = document.createElement("img");
  logo.className = "welcome__logo";
  logo.src = "/data/washoi.png";
  logo.alt = "Washiki Washoi";
  const wordmark = document.createElement("span");
  wordmark.className = "welcome__wordmark";
  wordmark.textContent = "WASHIKI WASHOI";
  logo.hidden = true;
  logo.addEventListener("load", () => {
    logo.hidden = false;
    wordmark.hidden = true;
  });
  logo.addEventListener("error", () => {
    logo.hidden = true;
    wordmark.hidden = false;
  });
  inner.append(logo, wordmark);
  panel.append(kanji, inner);

  const stage = document.createElement("div");
  stage.className = "welcome__stage";
  const light = document.createElement("div");
  light.className = "lobby__light";
  light.setAttribute("aria-hidden", "true");
  for (const tone of ["violet", "deep", "accent"]) {
    const orb = document.createElement("div");
    orb.className = `lobby__orb lobby__orb--${tone}`;
    light.appendChild(orb);
  }
  const ghost = document.createElement("div");
  ghost.className = "lobby__ghost";
  ghost.setAttribute("aria-hidden", "true");
  ghost.textContent = ghostText;
  stage.append(light, ghost);

  root.append(panel, stage);
  return { root, inner, stage, ghost };
}

const reducedMotion = (): boolean => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Widen the panel out of the rail: it starts at the rail's width and grows. */
export function widenFromRail(root: HTMLElement): void {
  if (reducedMotion()) return;
  root.classList.add("welcome--entering");
  // Two frames: the first lays the narrow panel out, the second lets it grow
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("welcome--entering")));
}

/** Narrow the panel back onto the rail, then take the overlay away. */
export function narrowOntoRail(root: HTMLElement, done: () => void): void {
  root.classList.add("welcome--leaving");
  setTimeout(
    () => {
      root.remove();
      done();
    },
    reducedMotion() ? 0 : MOVE_MS,
  );
}

/** A screen: a kicker over a big title, and a line under it. */
export function identityScreen(kicker: string, title: string, lead?: string | Array<string | Node>): HTMLFormElement {
  const form = document.createElement("form");
  form.className = "welcome__screen";
  form.autocomplete = "off";
  const kick = document.createElement("div");
  kick.className = "welcome__kicker";
  kick.textContent = kicker;
  const heading = document.createElement("h1");
  heading.className = "welcome__title";
  heading.textContent = title;
  form.append(kick, heading);
  if (lead) {
    const paragraph = document.createElement("p");
    paragraph.className = "welcome__lead";
    if (typeof lead === "string") paragraph.textContent = lead;
    else paragraph.append(...lead);
    form.appendChild(paragraph);
  }
  return form;
}
