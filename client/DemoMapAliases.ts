import { normalizeDemoMapName } from "../../../shared/demo/DemoMapName";

const aliases = new Map([
  ["washoidm2", "washoi_dm2"],
  ["washoidm5", "washoi_dm5"],
  ["washoidm11", "washoi_dm11"],
  ["wdm2", "washoi_dm2"],
  ["wfdm5", "washoi_dm5"],
  ["wfdm11", "washoi_dm11"],
]);

/** Resolve renamed media without rewriting a recording's identity or events. */
export function resolveFPSDemoMap(raw: string | null | undefined): string {
  const name = normalizeDemoMapName(raw);
  return aliases.get(name) ?? name;
}
