/**
 * bot:intel — distil bots' match reports into the checked-in baseline.
 *
 * Reads `<data-dir>/bot-intel.db` (bot/intel/IntelStore.ts), which the bot
 * server fills as bots finish matches, and writes `config/bot-intel/<map>.json`
 * (bot/intel/IntelBaseline.ts) for each map with reports, or the one named.
 * Run on demand, like `bot:learn`: review what changed, then commit it.
 *
 * Usage:
 *   npm run bot:intel -- [--data-dir <dir>] [--map <name>] [--dry-run]
 */

import { runCli } from "../../../cli/_runCli";
import { resolveDataDir } from "../../../lobby/ServerData";
import { buildBaseline, saveBaseline } from "../bot/intel/IntelBaseline";
import { IntelStore } from "../bot/intel/IntelStore";

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: npm run bot:intel -- [--data-dir <dir>] [--map <name>] [--dry-run]");
    return;
  }
  const store = IntelStore.open(resolveDataDir(option(args, "--data-dir")));
  try {
    const only = option(args, "--map");
    const maps = [...new Set(store.maps().map((m) => m.map))].filter((m) => !only || m === only);
    if (maps.length === 0) {
      console.log("bot:intel — no match reports" + (only ? ` for ${only}` : ""));
      return;
    }
    for (const map of maps) {
      const baseline = buildBaseline(store, map);
      const summary = Object.entries(baseline.gametypes)
        .map(
          ([gametype, g]) =>
            `${gametype}: ${g.matches} reports, ${g.fights.length} fight cells, ${g.payoffs.length} payoffs`,
        )
        .join("; ");
      if (args.includes("--dry-run")) console.log(`  ${map} — ${summary}`);
      else console.log(`  ${map} — ${summary} → ${saveBaseline(baseline)}`);
    }
  } finally {
    store.close();
  }
}

void runCli(main).then(() => process.exit(process.exitCode ?? 0));
