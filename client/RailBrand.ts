import { EngineVersion } from "../../../engine/core/EngineVersion";
import { UIStyles } from "../../../engine/ui/UIStyles";

const VERSION_CSS = `
.rail-version {
  display: block;
  margin-top: 6px;
  font: 700 11px / 1 var(--w-font-display, "Orbitron", monospace);
  letter-spacing: 0.18em;
  color: hsl(250 45% 7% / 0.55);
  user-select: text;
}
`;

/**
 * The game's logo at the head of a gold rail: the lobby's, the match menu's
 * and the in-game settings'. The logo is media and may not be installed, so the
 * name set in type stands in until it loads, and for good if it never does.
 * The version sits under it, so a screenshot for a bug report carries it.
 */
export function buildRailBrand(className: string): HTMLElement {
  const brand = document.createElement("div");
  brand.className = className;
  const logo = document.createElement("img");
  logo.src = "/data/washoi.png";
  logo.alt = "Washiki Washoi";
  const fallback = document.createElement("span");
  fallback.textContent = "WASHIKI WASHOI";
  logo.hidden = true;
  logo.addEventListener("load", () => {
    logo.hidden = false;
    fallback.hidden = true;
  });
  logo.addEventListener("error", () => {
    logo.hidden = true;
    fallback.hidden = false;
  });
  UIStyles.injectCSS("rail-version", VERSION_CSS);
  const version = document.createElement("small");
  version.className = "rail-version";
  version.textContent = EngineVersion.getInstance().getVersionString();
  brand.append(logo, fallback, version);
  return brand;
}
