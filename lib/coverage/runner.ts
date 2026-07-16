/**
 * Coverage-repair framework — the vendor-agnostic runner.
 *
 * Sequences the two stages across every registered provider: Stage 1 finds gaps (read-only), Stage 2
 * backfills them (per-vendor), then it waits for the async writes to land and recomputes the scoped
 * derived tables. Dry-run stops after Stage 1 (report only). Returns a structured result + the itemised
 * monitor text; the cron route posts it. Every phase is best-effort — one failure can't sink the run.
 */
import { sql } from "drizzle-orm";
import { parseDate } from "@internationalized/date";
import { planetscaleDb } from "@/lib/db/planetscale";
import { SystemsManager, type SystemWithPolling } from "@/lib/systems-manager";
import { sessionManager } from "@/lib/session-manager";
import { createPollCollector } from "@/lib/observations/poll-collector";
import { recomputeAgg1dForDay } from "@/lib/db/planetscale/aggregate-points-pg";
import { resolveLogicalSystem } from "@/lib/aggregation/logical-system";
import { recomputeFlowMatrixForDay } from "@/lib/db/planetscale/flow-matrix-pg";
import { learnAllForHandle } from "@/lib/db/planetscale/battery-provenance-daily-pg";
import { recomputeBatteryProvenanceForWindow } from "@/lib/db/planetscale/battery-provenance-pg";
import { dayToUnixRangeForAggregation } from "@/lib/aggregation/point-aggregates";
import { COVERAGE_PROVIDERS } from "./providers";
import {
  resolveCoveragePoints,
  findCoverageGaps,
  countMaxPresent,
} from "./find-gaps";
import type {
  CoverageGapDay,
  CoveragePoint,
  CoverageRepairProvider,
  DayRepair,
} from "./types";

type PgDb = NonNullable<typeof planetscaleDb>;

const num = (env: string | undefined, fallback: number): number => {
  const n = Number(env);
  return Number.isFinite(n) ? n : fallback;
};
const MAX_DAYS_PER_RUN = num(process.env.REPAIR_MAX_DAYS_PER_RUN, 120); // per vendor
const LANDING_WAIT_SECONDS = num(process.env.REPAIR_LANDING_WAIT_SECONDS, 120);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A UTC timestamp (`created_at`) → its local calendar day "YYYY-MM-DD" at the given bucket offset. */
function localDay(
  value: Date | string | null | undefined,
  offsetMin: number,
): string | null {
  if (!value) return null;
  const ms =
    value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + offsetMin * 60_000).toISOString().slice(0, 10);
}

/** Normalize a persisted `commissioned_on` (pg `date` → string, or Date) to a "YYYY-MM-DD" day. */
function normalizeDay(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

interface SystemReport {
  vendorType: string;
  systemId: number;
  name: string;
  gaps: CoverageGapDay[];
  repairs: DayRepair[];
}

export interface CoverageRepairResult {
  status: "ok" | "warn" | "alert";
  dryRun: boolean;
  window: { firstDay: string; lastDay: string };
  vendors: { vendorType: string; systems: number }[];
  totals: {
    repaired: number;
    unsettled: number;
    errors: number;
    deferredForCap: number;
    wouldRepair: number;
  };
  recompute: {
    agg1dDays: number;
    flowDays: number;
    provenanceAreas: number;
    pending: number;
  };
  reports: SystemReport[];
  reportText: string;
}

export async function runCoverageRepair(
  db: PgDb,
  opts: { dryRun: boolean; onlyVendor?: string },
): Promise<CoverageRepairResult> {
  const { dryRun, onlyVendor } = opts;
  const nowMs = Date.now();
  const providers = COVERAGE_PROVIDERS.filter(
    (p) => !onlyVendor || p.vendorType === onlyVendor,
  );
  const allSystems = await SystemsManager.getInstance().getActiveSystems();

  const reports: SystemReport[] = [];
  const pointsBySystem = new Map<number, CoveragePoint[]>();
  const providerBySystem = new Map<number, CoverageRepairProvider<unknown>>();
  const preRepairPresent = new Map<string, number>(); // `${sid}:${day}` → pre-repair maxPresent
  const publishedBySystem = new Map<number, string[]>();
  let deferredForCap = 0;

  // Representative window for the header (uniform 90/7, fixed +10 basis).
  const headToday = new Date(nowMs + 600 * 60_000).toISOString().slice(0, 10);
  const windowFirst = parseDate(headToday).subtract({ days: 90 }).toString();
  const windowLast = parseDate(headToday).subtract({ days: 7 }).toString();

  // ── Phases 0–2: enumerate → Stage 1 detect → Stage 2 backfill ──
  // Vendors run CONCURRENTLY (independent APIs / per-owner keys); systems within a vendor stay
  // sequential for now — see docs/architecture/coverage-repair.md (Parallelisation & scaling).
  await Promise.all(
    providers.map(async (provider) => {
      const systems = allSystems.filter(
        (s) => s.vendorType === provider.vendorType,
      );
      let repairBudget = MAX_DAYS_PER_RUN; // per-vendor budget (no cross-vendor starvation)

      for (const system of systems) {
        const offset = provider.bucketOffsetMin(system);
        const todayLocal = new Date(nowMs + offset * 60_000)
          .toISOString()
          .slice(0, 10);
        const lookbackFirst = parseDate(todayLocal)
          .subtract({ days: provider.lookbackDays })
          .toString();
        const lastDay = parseDate(todayLocal)
          .subtract({ days: provider.graceDays })
          .toString();

        // Floor the window start at the system's "birth" so pre-existence days aren't flagged as
        // phantom gaps — and, when a vendor exposes an earlier true commission date, so genuine
        // pre-onboarding history stays in range. Source order: persisted `commissioned_on`; else (for
        // a freshly-onboarded system only) the vendor's live commission day, lazily persisted; else
        // the LiveOne onboarding day (`created_at`).
        let floor = normalizeDay(system.commissionedOn);
        const createdDay = localDay(system.createdAt, offset);
        if (!floor) {
          // Pay for the vendor call only when onboarding itself is inside the lookback window (a
          // recently-added system); for long-onboarded systems the lookback floor already dominates.
          if (
            provider.commissionDay &&
            createdDay &&
            createdDay > lookbackFirst
          ) {
            try {
              const commissioned = await provider.commissionDay(system);
              if (commissioned) {
                floor = commissioned;
                if (!dryRun) {
                  try {
                    await db.execute(sql`
                      UPDATE systems SET commissioned_on = ${commissioned}
                      WHERE id = ${system.id} AND commissioned_on IS NULL
                    `);
                  } catch (err) {
                    console.error(
                      `[RepairCoverage] persist commissioned_on failed sys=${system.id}:`,
                      err,
                    );
                  }
                }
              }
            } catch {
              /* best-effort: fall through to created_at */
            }
          }
          if (!floor) floor = createdDay;
        }
        const firstDay = floor && floor > lookbackFirst ? floor : lookbackFirst;

        // Window collapses (system younger than the grace period) → nothing to scan.
        if (firstDay > lastDay) {
          reports.push({
            vendorType: provider.vendorType,
            systemId: system.id,
            name: system.displayName,
            gaps: [],
            repairs: [],
          });
          continue;
        }

        let points: CoveragePoint[];
        try {
          points = await resolveCoveragePoints(
            db,
            system.id,
            provider.expectedPointTails,
          );
        } catch (err) {
          reports.push({
            vendorType: provider.vendorType,
            systemId: system.id,
            name: system.displayName,
            gaps: [],
            repairs: [
              errRepair(system.id, `point lookup failed: ${String(err)}`),
            ],
          });
          continue;
        }
        pointsBySystem.set(system.id, points);
        providerBySystem.set(system.id, provider);
        if (points.length === 0) {
          reports.push({
            vendorType: provider.vendorType,
            systemId: system.id,
            name: system.displayName,
            gaps: [],
            repairs: [],
          });
          continue;
        }

        // STAGE 1 — detect (read-only)
        let gaps: CoverageGapDay[] = [];
        try {
          gaps = await findCoverageGaps(
            db,
            system.id,
            points,
            provider.cadenceMinutes,
            offset,
            firstDay,
            lastDay,
          );
        } catch (err) {
          reports.push({
            vendorType: provider.vendorType,
            systemId: system.id,
            name: system.displayName,
            gaps: [],
            repairs: [errRepair(system.id, `detection failed: ${String(err)}`)],
          });
          continue;
        }

        // STAGE 2 — backfill (dry-run stops at a would-repair preview)
        const repairs: DayRepair[] = [];
        if (gaps.length > 0 && dryRun) {
          for (const g of gaps)
            repairs.push({
              systemId: system.id,
              day: g.day,
              publishedRows: 0,
              status: "would-repair",
            });
        } else if (gaps.length > 0) {
          const prep = await provider.prepare(system);
          if (!prep.ok) {
            repairs.push(errRepair(system.id, prep.error));
          } else {
            const session = await sessionManager.createSession({
              sessionLabel: "repair-coverage",
              systemId: system.id,
              cause: "CRON",
              started: new Date(),
            });
            const collector = createPollCollector();
            const startTime = Date.now();
            for (const g of gaps) {
              if (repairBudget <= 0) {
                deferredForCap++;
                continue;
              }
              repairBudget--;
              preRepairPresent.set(`${system.id}:${g.day}`, g.maxPresent);
              const r = await provider.backfillDay(
                system,
                g.day,
                prep.ctx,
                session,
                collector,
              );
              repairs.push(r);
              if (r.status === "repaired") {
                if (!publishedBySystem.has(system.id))
                  publishedBySystem.set(system.id, []);
                publishedBySystem.get(system.id)!.push(g.day);
              }
            }
            // Flush the batched observations to the queue at session close.
            await sessionManager.updateSessionResult(
              session.id,
              {
                duration: Date.now() - startTime,
                successful: repairs.every((x) => x.status !== "error"),
                error: null,
                numRows: collector.observations.length,
                response: {
                  repaired: repairs.filter((x) => x.status === "repaired")
                    .length,
                },
              },
              collector.observations,
            );
          }
        }
        reports.push({
          vendorType: provider.vendorType,
          systemId: system.id,
          name: system.displayName,
          gaps,
          repairs,
        });
      }
    }),
  );

  // Concurrent vendors interleave pushes into `reports`; regroup by vendor order for a tidy report.
  const vendorOrder = new Map(providers.map((p, i) => [p.vendorType, i]));
  reports.sort(
    (a, b) =>
      (vendorOrder.get(a.vendorType) ?? 99) -
      (vendorOrder.get(b.vendorType) ?? 99),
  );

  // ── Phase 3: wait for landing, then Phase 4: scoped recompute ──
  const landedBySystem = new Map<number, string[]>();
  const recompute = {
    agg1dDays: 0,
    flowDays: 0,
    provenanceAreas: 0,
    pending: 0,
  };
  if (!dryRun && publishedBySystem.size > 0) {
    const deadline = Date.now() + LANDING_WAIT_SECONDS * 1000;
    const pending = new Map(
      [...publishedBySystem].map(([sid, days]) => [sid, new Set(days)]),
    );
    while (Date.now() < deadline) {
      for (const [sid, days] of pending) {
        const points = pointsBySystem.get(sid) ?? [];
        const provider = providerBySystem.get(sid)!;
        const system = allSystems.find((s) => s.id === sid)!;
        const offset = provider.bucketOffsetMin(system);
        const expected = Math.round(1440 / provider.cadenceMinutes);
        for (const day of [...days]) {
          let present = 0;
          try {
            present = await countMaxPresent(db, sid, points, day, offset);
          } catch (err) {
            console.error(
              `[RepairCoverage] landing check failed sys=${sid} day=${day}:`,
              err,
            );
          }
          const pre = preRepairPresent.get(`${sid}:${day}`) ?? 0;
          // Landed when the day is complete OR any progress is observed (OE/Sigen points may never
          // reach `expected`, so strict equality would hang forever).
          if (present >= expected || present > pre) {
            days.delete(day);
            if (!landedBySystem.has(sid)) landedBySystem.set(sid, []);
            landedBySystem.get(sid)!.push(day);
          }
        }
        if (days.size === 0) pending.delete(sid);
      }
      if (pending.size === 0) break;
      await sleep(5000);
    }
    recompute.pending = [...pending.values()].reduce((a, s) => a + s.size, 0);

    for (const [sid, days] of landedBySystem) {
      const system = allSystems.find((s) => s.id === sid);
      if (!system || days.length === 0) continue;

      for (const day of days) {
        try {
          await recomputeAgg1dForDay(db, system, parseDate(day));
          recompute.agg1dDays++;
        } catch (err) {
          console.error(
            `[RepairCoverage] agg_1d recompute failed sys=${sid} day=${day}:`,
            err,
          );
        }
      }

      let areaRows: {
        id: string;
        handle: number | null;
        tz: number;
        isBattery: boolean;
      }[] = [];
      try {
        const res = await db.execute(sql`
          SELECT DISTINCT a.id,
                 a.legacy_system_id AS handle,
                 a.timezone_offset_min AS tz,
                 EXISTS (SELECT 1 FROM area_bindings b2
                         WHERE b2.area_id = a.id AND b2.role='battery' AND b2.metric_type='power') AS is_battery
          FROM area_bindings b JOIN areas a ON a.id = b.area_id
          WHERE b.point_system_id = ${sid}
        `);
        areaRows = (res.rows ?? []).map((r) => ({
          id: String((r as { id: unknown }).id),
          handle:
            (r as { handle: unknown }).handle == null
              ? null
              : Number((r as { handle: unknown }).handle),
          tz: Number((r as { tz: unknown }).tz),
          isBattery: Boolean((r as { is_battery: unknown }).is_battery),
        }));
      } catch (err) {
        console.error(`[RepairCoverage] area lookup failed sys=${sid}:`, err);
      }

      for (const area of areaRows) {
        if (area.handle == null) continue;
        try {
          const ls = await resolveLogicalSystem(area.handle);
          if (ls && ls.isComplete)
            for (const day of days) {
              await recomputeFlowMatrixForDay(db, ls, parseDate(day));
              recompute.flowDays++;
            }
        } catch (err) {
          console.error(
            `[RepairCoverage] flow recompute failed area=${area.id}:`,
            err,
          );
        }
        if (area.isBattery) {
          try {
            await learnAllForHandle(db, area.handle, nowMs, { rebuild: false });
            const sorted = [...days].sort();
            const [winStartSec] = dayToUnixRangeForAggregation(
              parseDate(sorted[0]),
              area.tz,
            );
            const [, winEndSec] = dayToUnixRangeForAggregation(
              parseDate(sorted[sorted.length - 1]),
              area.tz,
            );
            await recomputeBatteryProvenanceForWindow(
              db,
              area.handle,
              winStartSec * 1000,
              winEndSec * 1000,
              {
                writeRollup: true,
                writeCheckpoints: true,
                updateLatest: false,
              },
            );
            recompute.provenanceAreas++;
          } catch (err) {
            console.error(
              `[RepairCoverage] provenance recompute failed area=${area.id}:`,
              err,
            );
          }
        }
      }
    }
  }

  // ── Phase 5: tallies + itemised report ──
  const allRepairs = reports.flatMap((r) => r.repairs);
  const repaired = allRepairs.filter((x) => x.status === "repaired").length;
  const unsettled = allRepairs.filter((x) => x.status === "unsettled").length;
  const errors = allRepairs.filter((x) => x.status === "error").length;
  const wouldRepair = allRepairs.filter(
    (x) => x.status === "would-repair",
  ).length;
  const status: "ok" | "warn" | "alert" =
    errors > 0
      ? "alert"
      : unsettled > 0 || deferredForCap > 0 || recompute.pending > 0
        ? "warn"
        : "ok";

  const icon = status === "alert" ? "🔴" : status === "warn" ? "🟡" : "🟢";
  const vendorCounts = providers
    .map(
      (p) =>
        `${p.vendorType} ${reports.filter((r) => r.vendorType === p.vendorType).length}`,
    )
    .join(", ");
  const lines: string[] = [
    `${icon} LiveOne weekly coverage repair${dryRun ? " [DRY-RUN]" : ""} — window ${windowFirst}..${windowLast} (7–90d); ${vendorCounts}`,
  ];
  const systemsToReport = reports.filter(
    (r) => r.gaps.length > 0 || r.repairs.some((x) => x.status === "error"),
  );
  for (const r of systemsToReport) {
    lines.push(
      `• ${r.vendorType} system ${r.systemId} (${r.name}): ${r.gaps.length} gap-day(s)`,
    );
    const byDay = new Map(r.repairs.map((rep) => [rep.day, rep]));
    for (const g of r.gaps) {
      const rep = byDay.get(g.day);
      const outcome = rep
        ? rep.status === "error"
          ? `error: ${rep.error}`
          : rep.status
        : "deferred (cap)";
      lines.push(
        `    – ${g.day}: ${g.maxMissing} int (${g.points.map((p) => p.tail).join(",")}) → ${outcome}`,
      );
    }
    const gapDays = new Set(r.gaps.map((g) => g.day));
    for (const rep of r.repairs)
      if (rep.status === "error" && !gapDays.has(rep.day))
        lines.push(`    – ${rep.day}: error: ${rep.error}`);
  }
  if (systemsToReport.length === 0)
    lines.push(`• no gaps found across ${reports.length} system(s)`);
  lines.push(
    `Totals: repaired ${repaired}, unsettled ${unsettled}, errors ${errors}, deferred(cap) ${deferredForCap}` +
      (dryRun ? `, would-repair ${wouldRepair}` : "") +
      `. Recompute: agg_1d ${recompute.agg1dDays}d, flow ${recompute.flowDays}d, provenance ${recompute.provenanceAreas} area(s)` +
      (recompute.pending > 0
        ? `; ${recompute.pending} day(s) not yet landed (recompute deferred).`
        : "."),
  );

  return {
    status,
    dryRun,
    window: { firstDay: windowFirst, lastDay: windowLast },
    vendors: providers.map((p) => ({
      vendorType: p.vendorType,
      systems: reports.filter((r) => r.vendorType === p.vendorType).length,
    })),
    totals: { repaired, unsettled, errors, deferredForCap, wouldRepair },
    recompute,
    reports,
    reportText: lines.join("\n"),
  };
}

function errRepair(systemId: number, error: string): DayRepair {
  return { systemId, day: "-", publishedRows: 0, status: "error", error };
}
