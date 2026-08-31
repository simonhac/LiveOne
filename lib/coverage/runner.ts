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
import { DeviceWriter } from "@/lib/registry/device-writer";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";
import type { DeviceConfigView } from "@/lib/registry/device-config";
import { sessionManager } from "@/lib/session-manager";
import { createPollCollector } from "@/lib/observations/poll-collector";
import { recomputeDerivedForDeviceDays } from "@/lib/aggregation/scoped-recompute";
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

/**
 * How far back a run scans, overriding each provider's own `lookbackDays`.
 *
 * The cron runs NIGHTLY, and a nightly pass over the full 90 days would re-fetch every
 * permanently-unrecoverable day in the window every night — nothing records that a gap has been
 * accepted, so the same days recur forever (see the "reported forever" note in
 * `docs/architecture/coverage-repair.md`). So the schedule is shallow-nightly, deep-weekly: the
 * nightly run covers the days that can still change (Amber settlement, this week's fresh holes)
 * and one run a week sweeps the whole window.
 *
 * `REPAIR_LOOKBACK_DAYS` / `REPAIR_SETTLEMENT_GRACE_DAYS` are the env overrides the docs have
 * always described; until now they existed only in the docs.
 */
const SHALLOW_LOOKBACK_DAYS = num(process.env.REPAIR_LOOKBACK_DAYS, 10);
const GRACE_DAYS_OVERRIDE = Number.isFinite(
  Number(process.env.REPAIR_SETTLEMENT_GRACE_DAYS),
)
  ? Number(process.env.REPAIR_SETTLEMENT_GRACE_DAYS)
  : null;
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

interface DeviceReport {
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
  vendors: { vendorType: string; devices: number }[];
  totals: {
    repaired: number;
    unsettled: number;
    errors: number;
    deferredForCap: number;
    wouldRepair: number;
  };
  recompute: {
    agg1dDays: number;
    provenanceAreas: number;
    pending: number;
  };
  reports: DeviceReport[];
  reportText: string;
}

export async function runCoverageRepair(
  db: PgDb,
  opts: {
    dryRun: boolean;
    onlyVendor?: string;
    /**
     * Days to scan back. Omitted = the shallow nightly default; `deep` = each provider's own
     * `lookbackDays` (90). Explicitly `null` also means deep, so a caller can ask for the full
     * sweep without knowing the number.
     */
    lookbackDays?: number | null;
    deep?: boolean;
  },
): Promise<CoverageRepairResult> {
  const { dryRun, onlyVendor } = opts;
  const deep = opts.deep === true || opts.lookbackDays === null;
  const nowMs = Date.now();
  const providers = COVERAGE_PROVIDERS.filter(
    (p) => !onlyVendor || p.vendorType === onlyVendor,
  );
  const allDevices = await DeviceConfigRegistry.activeDevices();

  const reports: DeviceReport[] = [];
  const pointsByDevice = new Map<number, CoveragePoint[]>();
  const providerByDevice = new Map<number, CoverageRepairProvider<unknown>>();
  const preRepairPresent = new Map<string, number>(); // `${sid}:${day}` → pre-repair maxPresent
  const publishedByDevice = new Map<number, string[]>();
  let deferredForCap = 0;

  // Representative window for the header (fixed +10 basis).
  //
  // Derived from the EFFECTIVE lookback, not the constant 90: a shallow run scans ~10 days, and a
  // header claiming 90 would make an unrepaired old gap read as a repair failure rather than as
  // out-of-window. Widest across the providers in play, since each caps the shallow window at its
  // own `lookbackDays`; the grace is theirs unless overridden.
  const headToday = new Date(nowMs + 600 * 60_000).toISOString().slice(0, 10);
  // `providers` is empty when `--vendor` matches nothing; spread-Math would give ±Infinity and the
  // date arithmetic below would produce nonsense rather than an empty report.
  const headLookbacks = providers.map((p) =>
    deep
      ? p.lookbackDays
      : Math.min(p.lookbackDays, opts.lookbackDays ?? SHALLOW_LOOKBACK_DAYS),
  );
  const headLookback = headLookbacks.length ? Math.max(...headLookbacks) : 0;
  const headGraces = providers.map((p) => GRACE_DAYS_OVERRIDE ?? p.graceDays);
  const headGrace = headGraces.length ? Math.min(...headGraces) : 0;
  const windowFirst = parseDate(headToday)
    .subtract({ days: headLookback })
    .toString();
  const windowLast = parseDate(headToday)
    .subtract({ days: headGrace })
    .toString();

  // ── Phases 0–2: enumerate → Stage 1 detect → Stage 2 backfill ──
  // Vendors run CONCURRENTLY (independent APIs / per-owner keys); devices within a vendor stay
  // sequential for now — see docs/architecture/coverage-repair.md (Parallelisation & scaling).
  await Promise.all(
    providers.map(async (provider) => {
      const devices = allDevices.filter(
        (s) => s.vendorType === provider.vendorType,
      );
      let repairBudget = MAX_DAYS_PER_RUN; // per-vendor budget (no cross-vendor starvation)

      for (const device of devices) {
        const offset = provider.bucketOffsetMin(device);
        const todayLocal = new Date(nowMs + offset * 60_000)
          .toISOString()
          .slice(0, 10);
        // A deep run uses the provider's own window; a shallow one is capped, and never widened
        // past it — a shallow pass is a subset of the deep pass, never a different window.
        const lookbackDays = deep
          ? provider.lookbackDays
          : Math.min(
              provider.lookbackDays,
              opts.lookbackDays ?? SHALLOW_LOOKBACK_DAYS,
            );
        const graceDays = GRACE_DAYS_OVERRIDE ?? provider.graceDays;
        const lookbackFirst = parseDate(todayLocal)
          .subtract({ days: lookbackDays })
          .toString();
        const lastDay = parseDate(todayLocal)
          .subtract({ days: graceDays })
          .toString();

        // Floor the window start at the device's "birth" so pre-existence days aren't flagged as
        // phantom gaps — and, when a vendor exposes an earlier true commission date, so genuine
        // pre-onboarding history stays in range. Source order: persisted `commissioned_on`; else (for
        // a freshly-onboarded device only) the vendor's live commission day, lazily persisted; else
        // the LiveOne onboarding day (`created_at`).
        let floor = normalizeDay(device.commissionedOn);
        const createdDay = localDay(device.createdAt, offset);
        if (!floor) {
          // Pay for the vendor call only when onboarding itself is inside the lookback window (a
          // recently-added device); for long-onboarded devices the lookback floor already dominates.
          if (
            provider.commissionDay &&
            createdDay &&
            createdDay > lookbackFirst
          ) {
            try {
              const commissioned = await provider.commissionDay(device);
              if (commissioned) {
                floor = commissioned;
                if (!dryRun) {
                  try {
                    // config-v4 slice K2: this was a hand-written `UPDATE systems` that bypassed
                    // `updateDevice` and therefore the `devices` mirror entirely — a THIRD instance of
                    // the "wired at mint, not at edit" class, and the only one where the writer was not
                    // even the sanctioned one. `commissioned_on` is the coverage window's floor, so a
                    // drifted mirror manufactures phantom gaps once `devices` is the reader. Routed
                    // through the mirrored writer; the old statement's `AND commissioned_on IS NULL`
                    // guard is preserved by the enclosing `if (!floor)`, and this is a weekly single
                    // writer, so there is no concurrent update to lose.
                    await DeviceWriter.updateDevice(device.id, {
                      commissionedOn: commissioned,
                    });
                  } catch (err) {
                    console.error(
                      `[RepairCoverage] persist commissioned_on failed sys=${device.id}:`,
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

        // Window collapses (device younger than the grace period) → nothing to scan.
        if (firstDay > lastDay) {
          reports.push({
            vendorType: provider.vendorType,
            systemId: device.id,
            name: device.displayName,
            gaps: [],
            repairs: [],
          });
          continue;
        }

        let points: CoveragePoint[];
        try {
          points = await resolveCoveragePoints(
            db,
            device.id,
            provider.expectedPointTails,
          );
        } catch (err) {
          reports.push({
            vendorType: provider.vendorType,
            systemId: device.id,
            name: device.displayName,
            gaps: [],
            repairs: [
              errRepair(device.id, `point lookup failed: ${String(err)}`),
            ],
          });
          continue;
        }
        pointsByDevice.set(device.id, points);
        providerByDevice.set(device.id, provider);
        if (points.length === 0) {
          reports.push({
            vendorType: provider.vendorType,
            systemId: device.id,
            name: device.displayName,
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
            device.id,
            points,
            provider.cadenceMinutes,
            offset,
            firstDay,
            lastDay,
          );
        } catch (err) {
          reports.push({
            vendorType: provider.vendorType,
            systemId: device.id,
            name: device.displayName,
            gaps: [],
            repairs: [errRepair(device.id, `detection failed: ${String(err)}`)],
          });
          continue;
        }

        // STAGE 2 — backfill (dry-run stops at a would-repair preview)
        const repairs: DayRepair[] = [];
        if (gaps.length > 0 && dryRun) {
          for (const g of gaps)
            repairs.push({
              systemId: device.id,
              day: g.day,
              publishedRows: 0,
              status: "would-repair",
            });
        } else if (gaps.length > 0) {
          const prep = await provider.prepare(device);
          if (!prep.ok) {
            repairs.push(errRepair(device.id, prep.error));
          } else {
            const session = await sessionManager.createSession({
              sessionLabel: "repair-coverage",
              systemId: device.id,
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
              preRepairPresent.set(`${device.id}:${g.day}`, g.maxPresent);
              const r = await provider.backfillDay(
                device,
                g.day,
                prep.ctx,
                session,
                collector,
              );
              repairs.push(r);
              if (r.status === "repaired") {
                if (!publishedByDevice.has(device.id))
                  publishedByDevice.set(device.id, []);
                publishedByDevice.get(device.id)!.push(g.day);
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
          systemId: device.id,
          name: device.displayName,
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
  const landedByDevice = new Map<number, string[]>();
  const recompute = {
    agg1dDays: 0,
    provenanceAreas: 0,
    pending: 0,
  };
  if (!dryRun && publishedByDevice.size > 0) {
    const deadline = Date.now() + LANDING_WAIT_SECONDS * 1000;
    const pending = new Map(
      [...publishedByDevice].map(([sid, days]) => [sid, new Set(days)]),
    );
    while (Date.now() < deadline) {
      for (const [sid, days] of pending) {
        const points = pointsByDevice.get(sid) ?? [];
        const provider = providerByDevice.get(sid)!;
        const device = allDevices.find((s) => s.id === sid)!;
        const offset = provider.bucketOffsetMin(device);
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
            if (!landedByDevice.has(sid)) landedByDevice.set(sid, []);
            landedByDevice.get(sid)!.push(day);
          }
        }
        if (days.size === 0) pending.delete(sid);
      }
      if (pending.size === 0) break;
      await sleep(5000);
    }
    recompute.pending = [...pending.values()].reduce((a, s) => a + s.size, 0);

    // The per-device recompute is shared with the Sigenergy backfill route
    // (`lib/aggregation/scoped-recompute.ts`) — the same "these device-days changed" work, and
    // keeping one copy is what stops the two drifting.
    for (const [sid, days] of landedByDevice) {
      const device = allDevices.find((s) => s.id === sid);
      if (!device || days.length === 0) continue;
      const r = await recomputeDerivedForDeviceDays(
        db,
        device,
        days,
        nowMs,
        "RepairCoverage",
      );
      recompute.agg1dDays += r.agg1dDays;
      recompute.provenanceAreas += r.provenanceAreas;
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
    `${icon} LiveOne ${deep ? "deep" : "nightly"} coverage repair${dryRun ? " [DRY-RUN]" : ""} — window ${windowFirst}..${windowLast}; ${vendorCounts}`,
  ];
  const devicesToReport = reports.filter(
    (r) => r.gaps.length > 0 || r.repairs.some((x) => x.status === "error"),
  );
  for (const r of devicesToReport) {
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
  if (devicesToReport.length === 0)
    lines.push(`• no gaps found across ${reports.length} system(s)`);
  lines.push(
    `Totals: repaired ${repaired}, unsettled ${unsettled}, errors ${errors}, deferred(cap) ${deferredForCap}` +
      (dryRun ? `, would-repair ${wouldRepair}` : "") +
      `. Recompute: agg_1d ${recompute.agg1dDays}d, provenance ${recompute.provenanceAreas} area(s)` +
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
      devices: reports.filter((r) => r.vendorType === p.vendorType).length,
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
