#!/usr/bin/env npx vite-node
/**
 * demo:verify — deterministic re-sim verification of a re-sim bundle (WO-AC4b).
 *
 * Reads a `.shagverify` bundle (usercmd log + golden per-tick checksums), replays
 * the inputs through the authoritative sim, and confirms the checksums reconcile.
 * A clean bundle reconciles; a tampered log or doctored checksum diverges — the
 * demo becomes tamper-evident ground truth.
 *
 * Usage:
 *   npm run demo:verify -- <path-to-bundle.shagverify>
 *
 * Exit code 0 = reconciled, 1 = diverged / error.
 *
 * (Scope: the movement-oracle bundle from ReSim/ReSimBundle. Verifying a full
 * .shagdemo match needs full-server re-sim — a separate extension.)
 */

import * as fs from "node:fs";
import { verifyBundle } from "../server/ReSimBundle";

function main(): void {
  const file = process.argv.slice(2).find((a) => !a.startsWith("-"));
  if (!file) {
    console.error("Usage: npm run demo:verify -- <bundle.shagverify>");
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(`[demo:verify] File not found: ${file}`);
    process.exit(1);
  }

  let result: ReturnType<typeof verifyBundle>;
  try {
    result = verifyBundle(new Uint8Array(fs.readFileSync(file)));
  } catch (err) {
    console.error(`[demo:verify] Failed to read/parse bundle: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  if (result.ok) {
    console.log(`[demo:verify] ✅ RECONCILED — ${file} re-simulates to its recorded checksums.`);
    process.exit(0);
  } else {
    console.log(
      `[demo:verify] ❌ DIVERGED at tick ${result.divergedAtTick} — ${file} does not match its recorded checksums (tampered demo or non-deterministic sim).`,
    );
    process.exit(1);
  }
}

main();
