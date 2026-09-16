/**
 * Run the scattered `flow_attr_1d` backlog sweep on demand, and report HOW FAR IT GOT.
 *
 * The nightly `cron/daily` calls `rehealStaleAttrDays` last, under a wall-clock budget. This runs
 * exactly that function against whatever `.env.local` points at, so the per-day cost and the drain
 * rate can be measured instead of guessed — the numbers you need before choosing a budget.
 *
 * A model-version bump (FLOW_ATTR_VERSION / BATPROV_MODEL_VERSION) makes EVERY stored day stale at
 * once, so this is also how you drain that backlog faster than one nightly run at a time.
 *
 *   # what's outstanding, and what one budgeted run WOULD do — writes nothing
 *   npx tsx --env-file=.env.local scripts/utils/reheal-flow-attr.ts
 *
 *   # actually run one sweep with the default 60s budget
 *   npx tsx --env-file=.env.local scripts/utils/reheal-flow-attr.ts --apply
 *
 *   # measure: a 20s budget, then read days/selected and ms-per-day off the summary
 *   npx tsx --env-file=.env.local scripts/utils/reheal-flow-attr.ts --apply --budget=20s
 *
 *   # drain: repeat until the backlog is empty or nothing moves
 *   npx tsx --env-file=.env.local scripts/utils/reheal-flow-attr.ts --apply --budget=120s --repeat=10
 *
 * 🛑 `--apply` WRITES (it re-materialises `point_readings_flow_attr_1d` and rewrites fold
 * checkpoints), to whichever database `.env.local` names. Check the host it prints first.
 */
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { rehealStaleAttrDays } from "@/lib/battery-provenance/recompute";
import { FLOW_ATTR_VERSION } from "@/lib/db/planetscale/battery-provenance-pg";
import { sql } from "drizzle-orm";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string) =>
  argv.find((a) => a.startsWith(`${f}=`))?.split("=")[1];

/** "90s" / "2m" / "45000" → ms. */
function duration(s: string | undefined, fallback: number): number {
  if (!s) return fallback;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(s.trim());
  if (!m) throw new Error(`bad duration: ${s}`);
  const n = Number(m[1]);
  return m[2] === "m" ? n * 60_000 : m[2] === "ms" ? n : n * 1000;
}

async function backlog(): Promise<{ total: number; oldest: string | null }> {
  const db = requirePlanetscaleDb();
  const res = await db.execute(sql`
    SELECT count(*)::int AS n, min(day) AS oldest
    FROM (
      SELECT DISTINCT area_id, day
      FROM point_readings_flow_attr_1d
      WHERE finalized_at IS NULL OR version < ${FLOW_ATTR_VERSION}
    ) x
  `);
  const row = (res.rows ?? [])[0] as { n: unknown; oldest: unknown };
  return {
    total: Number(row?.n ?? 0),
    oldest: row?.oldest == null ? null : String(row.oldest),
  };
}

async function main() {
  const apply = has("--apply");
  const budgetMs = duration(val("--budget"), 60_000);
  const limit = val("--limit") ? Number(val("--limit")) : undefined;
  const repeat = val("--repeat") ? Number(val("--repeat")) : 1;

  const host = (process.env.PLANETSCALE_DATABASE_URL ?? "").replace(
    /\/\/[^@]*@/,
    "//***@",
  );
  console.error(`target: ${host || "(no PLANETSCALE_DATABASE_URL)"}`);
  console.error(
    `mode:   ${apply ? "APPLY (writes)" : "report-only"}  budget=${budgetMs}ms` +
      `${limit ? ` limit=${limit}` : ""}${repeat > 1 ? ` repeat=${repeat}` : ""}`,
  );

  const before = await backlog();
  console.log(
    `backlog: ${before.total} area-day(s) stale` +
      (before.oldest ? `, oldest ${before.oldest}` : ""),
  );
  if (!apply) {
    console.log("\n(report only — pass --apply to run a sweep)");
    return;
  }

  let totalHealed = 0;
  for (let i = 1; i <= repeat; i++) {
    const r = await rehealStaleAttrDays(Date.now(), { budgetMs, limit });
    totalHealed += r.days;
    const perDay = r.days > 0 ? Math.round(r.elapsedMs / r.days) : 0;
    console.log(
      `run ${i}: healed ${r.days}/${r.selected} day(s) across ${r.handles} handle(s) ` +
        `in ${r.elapsedMs}ms (${perDay}ms/day)` +
        (r.timedOut
          ? `  — BUDGET SPENT, ${r.remaining} left over`
          : "  — selection exhausted"),
    );
    if (r.days === 0) {
      console.log("nothing moved; stopping");
      break;
    }
  }

  const after = await backlog();
  console.log(
    `\nbacklog: ${before.total} → ${after.total} (${totalHealed} healed this session)`,
  );
  if (after.total > 0)
    console.log(
      `at this rate: ~${Math.ceil(after.total / Math.max(1, totalHealed / repeat))} more run(s)`,
    );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
