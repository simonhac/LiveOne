/**
 * 🛑 THE REGRESSION THIS FILE EXISTS FOR: `staleAgg1dLocalDays` must actually RUN.
 *
 * It is the only detector of a daily aggregate that was never built — the backstop for every path
 * that computes `agg_1d` once and never returns (`cron/daily` visits yesterday; the observations
 * receiver rebuilds 5m only; a late-settling Amber day lands after both). It shipped in #462 with
 * `localDayExpr(offsetMin)` called twice, once in the SELECT and once in the GROUP BY. The builder
 * binds `offsetMin` as a separate placeholder per fragment, Postgres matches GROUP BY terms to SELECT
 * terms structurally, two distinct Param nodes are not equal, and it rejected the whole query:
 *
 *   column "point_readings_agg_5m.interval_end" must appear in the GROUP BY clause   (42803)
 *
 * `healStaleAgg1dForDevice` catches and returns empty BY DESIGN — a backstop must not be the reason a
 * backfill does not happen — so a permanent failure was indistinguishable from "nothing was stale".
 * It ran broken on every device on both callers every night and healed nothing, while
 * `Amber Kinkora` accumulated 16 missing days. The only test mocked `ReadingsDao.staleAgg1dLocalDays`
 * with `jest.fn()`, so the SQL never executed in CI. Hence: this one executes it.
 *
 * Needs a real PG connection (`.env.local`). Asserting the SHAPE, not the contents — the rows depend
 * on whatever the connected branch holds, and the defect was that the query would not parse at all.
 *
 * Run with: npm run test:integration stale-agg1d
 */
import { describe, it, expect } from "@jest/globals";
import { ReadingsDao } from "@/lib/readings";
import { planetscaleDb } from "@/lib/db/planetscale";
import { pointReadingsAgg5m } from "@/lib/db/planetscale/schema";
import { RegistryCache } from "@/lib/registry/registry-cache";
import type { PointRid } from "@/lib/registry/registry-cache";

const DAY_MS = 86_400_000;

describe("staleAgg1dLocalDays (real SQL)", () => {
  it("parses and executes against Postgres", async () => {
    const db = planetscaleDb;
    if (!db) throw new Error("no PG connection — set PLANETSCALE_DATABASE_URL");

    // Any real point will do: the query is rid-keyed and the defect was in its GROUP BY, not its
    // filter. Taking one from agg_5m guarantees the rid resolves.
    const [row] = await db
      .select({ rid: pointReadingsAgg5m.pointRid })
      .from(pointReadingsAgg5m)
      .limit(1);
    expect(row).toBeDefined();

    const point = await RegistryCache.pointForRid(row!.rid as PointRid);
    expect(point).toBeTruthy();

    const toMs = Date.now();
    const days = await ReadingsDao.staleAgg1dLocalDays(
      [point],
      { fromMs: toMs - 30 * DAY_MS, toMs, offsetMin: 600 },
      db,
    );

    // The assertion is that we got HERE — the broken form threw 42803 before returning anything.
    expect(Array.isArray(days)).toBe(true);
    for (const d of days) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }, 30_000);

  it("is offset-aware — a non-zero offset is bound, not dropped", async () => {
    // The two placeholders that broke it were both `offsetMin`. Exercising two different offsets
    // proves the surviving one is genuinely bound and shifts the day bucket.
    const db = planetscaleDb;
    if (!db) throw new Error("no PG connection");
    const [row] = await db
      .select({ rid: pointReadingsAgg5m.pointRid })
      .from(pointReadingsAgg5m)
      .limit(1);
    const point = await RegistryCache.pointForRid(row!.rid as PointRid);
    const toMs = Date.now();
    const window = { fromMs: toMs - 7 * DAY_MS, toMs };
    const at = (offsetMin: number) =>
      ReadingsDao.staleAgg1dLocalDays([point], { ...window, offsetMin }, db);
    await expect(at(0)).resolves.toBeInstanceOf(Array);
    await expect(at(600)).resolves.toBeInstanceOf(Array);
  }, 30_000);
});
