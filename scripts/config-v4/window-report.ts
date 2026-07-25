#!/usr/bin/env tsx
/**
 * config-v4 window-fit report (Phase 7). Reads the timings config-transform.ts wrote and emits the
 * go/no-go verdict against the maintenance-window budget. Thresholds are env-overridable.
 *
 *   T_window (measured, cold) × safety-margin  ≤  W_target      → GO (single-window)
 *   ...                                        ≤  hard budget   → TIGHT (consider scaling the cutover box up)
 *   otherwise                                                    → NO-GO (use pre-copy + delta-catchup)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MARGIN = Number(process.env.CONFIG_V4_MARGIN ?? 3); // covers HA/concurrency/cache the idle branch can't show
const W_TARGET_S = Number(process.env.CONFIG_V4_W_TARGET_S ?? 1800); // 30-min pause budget (Simon)
const BUDGET_S = Number(process.env.CONFIG_V4_BUDGET_S ?? 7200); // 2h hard budget (Simon)

const file =
  process.env.CONFIG_V4_TIMINGS_FILE ??
  join(process.cwd(), ".context", "config-v4-timings.json");
const data = JSON.parse(readFileSync(file, "utf8")) as {
  timings: { stage: string; ms: number }[];
  totalMs: number;
  skipHot?: boolean;
};

const tWindowS = data.totalMs / 1000;
const projected = tWindowS * MARGIN;
const min = (s: number) => `${(s / 60).toFixed(1)} min`;

console.log("=== config-v4 window-fit ===");
for (const t of data.timings)
  console.log(`  ${t.stage.padEnd(22)} ${(t.ms / 1000).toFixed(1)}s`);
console.log(
  `\n  T_window (measured, cold) : ${tWindowS.toFixed(1)}s (${min(tWindowS)})`,
);
if (data.skipHot)
  console.log(
    "  ⚠️  --skip-hot was set — the 15M copy + index build are NOT in this measurement.",
  );
console.log(
  `  × safety margin ${MARGIN}         : ${projected.toFixed(1)}s (${min(projected)})`,
);
console.log(
  `  W_target (pause budget)   : ${W_TARGET_S}s (${min(W_TARGET_S)})`,
);
console.log(`  hard budget               : ${BUDGET_S}s (${min(BUDGET_S)})`);

let verdict: string;
let ok = false;
if (data.skipHot)
  verdict =
    "⚠️ INCONCLUSIVE — re-run without --skip-hot to measure the hot rewrite";
else if (projected <= W_TARGET_S) {
  verdict = "✅ GO — single-window fits with margin";
  ok = true;
} else if (projected <= BUDGET_S)
  verdict =
    "⚠️ TIGHT — within the hard budget but over W_target; scale the cutover instance up (bigger box = faster + more headroom) or trim the target";
else
  verdict =
    "❌ NO-GO — exceeds the budget; switch to pre-copy + delta-catchup (§5.3)";

console.log(`\n  VERDICT: ${verdict}`);
if (!ok) process.exitCode = 1;
