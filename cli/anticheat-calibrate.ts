#!/usr/bin/env npx vite-node
/**
 * anticheat:calibrate — measure the accuracy signal's detection vs false-positive
 * rate against labeled synthetic data (anti-cheat WO-AC3, the §0.3 guardrail).
 *
 * Runs N "aimbot" (near-perfect aim) and N "human" (noisy aim) combat trials,
 * measures the resulting hitscan accuracy, and prints — per candidate threshold —
 * the detection rate (aimbots caught) and false-positive rate (humans wrongly
 * flagged). Use it to pick a threshold *before* any signal is allowed to gate.
 *
 * Usage:
 *   npm run anticheat:calibrate -- [--trials 40] [--ticks 1500] [--human-deg 6] [--aimbot-deg 0.4]
 *
 * NOTE (risk R2): the synthetic "human" is a stand-in and our demos are me-vs-bot,
 * so treat the numbers as DIRECTIONAL until calibrated against real player demos.
 */

import { type CalibrateOptions, calibrateAccuracy, mean } from "../server/Calibrate";

function parseArgs(): CalibrateOptions {
  const args = process.argv.slice(2);
  const opts: CalibrateOptions = {};
  for (let i = 0; i < args.length; i++) {
    const v = args[i + 1];
    switch (args[i]) {
      case "--trials":
        opts.trials = parseInt(v, 10);
        i++;
        break;
      case "--ticks":
        opts.ticks = parseInt(v, 10);
        i++;
        break;
      case "--human-deg":
        opts.humanNoiseDeg = parseFloat(v);
        i++;
        break;
      case "--aimbot-deg":
        opts.aimbotNoiseDeg = parseFloat(v);
        i++;
        break;
    }
  }
  return opts;
}

function main(): void {
  const opts = parseArgs();
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(" Anti-cheat calibration — accuracy signal (WO-AC3)");
  console.log("═══════════════════════════════════════════════════════════════");
  const { humanAccuracies, aimbotAccuracies, rows } = calibrateAccuracy(opts);

  console.log(
    `\n  trials/side: ${aimbotAccuracies.length}   ` +
      `human mean acc: ${(mean(humanAccuracies) * 100).toFixed(1)}%   ` +
      `aimbot mean acc: ${(mean(aimbotAccuracies) * 100).toFixed(1)}%\n`,
  );
  console.log("  threshold   detection%   falsePositive%");
  console.log("  ─────────   ──────────   ──────────────");
  for (const r of rows) {
    console.log(
      `  ${(r.threshold * 100).toFixed(0).padStart(6)}%   ${(r.detectionRate * 100)
        .toFixed(1)
        .padStart(9)}%   ${(r.falsePositiveRate * 100).toFixed(1).padStart(12)}%`,
    );
  }
  console.log(
    "\n  Pick the highest detection% with an acceptable falsePositive% (ideally 0)." +
      "\n  ⚠ Directional only — synthetic human; recalibrate on real player demos (R2).\n",
  );
}

main();
