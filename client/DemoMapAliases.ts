import { normalizeDemoMapName } from "../../../shared/demo/DemoMapName";

const aliases = new Map([
  ["wdm2", "washoidm2"],
  ["wfdm5", "washoidm5"],
  ["wfdm11", "washoidm11"],
]);

/** Resolve renamed media without rewriting a recording's identity or events. */
export function resolveFPSDemoMap(raw: string | null | undefined): string {
  const name = normalizeDemoMapName(raw);
  return aliases.get(name) ?? name;
}
