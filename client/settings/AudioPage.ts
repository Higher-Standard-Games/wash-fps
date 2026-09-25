/**
 * Audio: music and effects, each with its volume in large numbers.
 */

import { Cvar } from "../../../../engine/core/Cvar";
import { card, el, type FieldHost, formatPercent, seg, slider } from "./SettingsFields";
import { cvarDefault } from "./SettingsModel";

/** Turn a flag on or off, whether it is stored as a boolean or as 0 and 1. */
function setFlag(name: string, on: boolean): void {
  Cvar.set(name, Cvar.getCvar(name)?.type === "bool" ? on : on ? 1 : 0);
}

export class AudioPage {
  readonly root: HTMLElement;

  constructor(host: FieldHost) {
    this.root = el("div", "fps-set-audio");
    for (const [title, enabled, volume] of [
      ["Music", "s_musicenabled", "s_volume"],
      ["Effects", "s_sfxenabled", "s_sfxvolume"],
    ]) {
      const root = card(title);
      const vol = el("div", "fps-set-vol");
      const big = el("div", "fps-set-vol__big");
      big.setAttribute("aria-hidden", "true");
      const rest = el("div", "fps-set-stack");
      vol.append(big, rest);
      root.append(vol);
      this.root.append(root);

      seg(host, rest, {
        name: "Sound",
        choices: [
          { value: 0, label: "Off" },
          { value: 1, label: "On" },
        ],
        get: () => (Cvar.getBool(enabled) ? 1 : 0),
        set: (value) => setFlag(enabled, value === 1),
      });
      slider(host, rest, {
        name: "Volume",
        min: 0,
        max: 1,
        step: 0.05,
        format: formatPercent,
        get: () => Cvar.getNumber(volume),
        set: (value) => Cvar.set(volume, value),
        initial: () => Number(cvarDefault(volume)),
      });
      host.addRefresh(() => {
        big.replaceChildren(String(Math.round(Cvar.getNumber(volume) * 100)), el("small", "", "%"));
        vol.classList.toggle("is-muted", !Cvar.getBool(enabled));
      });
    }
  }
}
