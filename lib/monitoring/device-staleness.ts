/**
 * Per-device poll health — one definition, two readers.
 *
 * `/api/cron/monitor-observations` alerts on this every 15 min from inside the app;
 * `/api/health/devices` exposes the same verdict so an external monitor can reach it without
 * trusting anything in here to still be able to speak. They must not be allowed to drift into two
 * different notions of "stale", so the evaluation lives here and neither owns it.
 */

import { sql } from "drizzle-orm";
import type { planetscaleDb } from "@/lib/db/planetscale";
import {
  maintenanceWindowOpenForMs,
  type MaintenanceWindow,
} from "@/lib/vendors/maintenance-window";

const num = (env: string | undefined, fallback: number): number => {
  const n = Number(env);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * A device is stale once it has missed this many of its OWN slots in a row. 3 tolerates a vendor
 * blip plus the ~3% of Vercel cron ticks that never fire, without tolerating a real outage.
 */
const DEVICE_STALE_SLOTS = num(process.env.MONITOR_DEVICE_STALE_SLOTS, 3);

/**
 * Consecutive failed polls before a device is called failing.
 *
 * The leading indicator, and the reason it is separate from staleness: a vendor with a generous
 * budget can fail every single poll for forty minutes and still look perfectly healthy to the
 * staleness check, because the cliff hasn't been reached. This is the poll-side twin of the hub's
 * `consecutive failed ticks` line — on 2026-09-11 the collector had two self-recovering episodes
 * hours before it died for good, and nothing was watching for them.
 *
 * ⚠️ This is the same number as `BREAKER_AFTER_ERRORS` (`lib/vendors/schedule.ts`), so it trips at
 * the exact moment the retry breaker opens — i.e. for ANY vendor outage lasting ~3 slots. That is
 * the intent for an unscheduled outage, and precisely wrong for a scheduled one, which is what
 * `MaintenanceWindow` exists to tell apart. See the Amber adapter for the worked example.
 */
export const DEVICE_FAILING_ERRORS = num(
  process.env.MONITOR_DEVICE_FAILING_ERRORS,
  5,
);

type DeviceHealthCode =
  | "ok"
  | "device_poll_stale"
  | "device_failing"
  | "device_never_polled"
  /** Stale or failing, but inside its vendor's declared maintenance window: report, don't alert. */
  | "device_in_maintenance";

export interface DeviceHealth {
  rid: number;
  name: string;
  vendor: string;
  code: DeviceHealthCode;
  /** minutes since the last successful poll; null = never succeeded */
  staleMin: number | null;
  /** the budget it was judged against (minutes) */
  budgetMin: number;
  consecutiveErrors: number;
  message: string;
}

interface DeviceRow {
  rid: number;
  name: string;
  vendor: string;
  /** ms since the last successful poll, on the DATABASE clock; null = never succeeded. */
  stale_ms: string | null;
  /** The database's `now()` — the single clock both `stale_ms` and the window are measured on. */
  db_now_ms: string;
  consecutive_errors: number | null;
}

interface StaleAdapter {
  dataSource?: string;
  pollIntervalMinutes?: number;
  staleBudgetMinutes?: number;
  maintenanceWindow?: MaintenanceWindow;
}

/**
 * Evaluate every active POLL device's health.
 *
 * Push vendors (the Fly hub's deepsea/fusher sites) are skipped: they have no schedule to be late
 * against, so their freshness is the pusher's problem and is covered by their own external
 * heartbeats. Derived `helper` devices are skipped for the same reason — nothing polls them.
 *
 * 🛑 **The database's clock is the only clock.** Staleness and the maintenance-window position get
 * subtracted from each other, so they must be sampled at the same instant: `now()` in the query
 * versus `new Date()` in the process differ by the query latency, which is enough to move a verdict
 * at the tolerance boundary even with perfectly synchronised clocks. The query therefore returns
 * `db_now_ms` alongside `stale_ms`, and nothing here reads the process clock. Tests supply both,
 * so they exercise the production path rather than a parallel one.
 */
export async function evaluateDeviceHealth(
  db: NonNullable<typeof planetscaleDb>,
): Promise<DeviceHealth[]> {
  const { VendorRegistry } = await import("@/lib/vendors/registry");
  const rows =
    (
      (await db.execute(sql`
        SELECT d.rid, d.name, d.vendor,
               (extract(epoch FROM (now() - ds.last_success_time)) * 1000)::bigint AS stale_ms,
               (extract(epoch FROM now()) * 1000)::bigint AS db_now_ms,
               ds.consecutive_errors
        FROM devices d
        LEFT JOIN device_state ds ON ds.device_id = d.id
        WHERE d.status = 'active'
        ORDER BY d.rid`)) as unknown as { rows?: DeviceRow[] }
    ).rows ?? [];

  const out: DeviceHealth[] = [];
  for (const row of rows) {
    const adapter = VendorRegistry.getAdapter(
      row.vendor,
    ) as unknown as StaleAdapter | null;
    if (!adapter || adapter.dataSource === "push") continue;

    const slot = adapter.pollIntervalMinutes ?? 5;
    const declared = adapter.staleBudgetMinutes;
    const budgetMin = declared ?? slot * DEVICE_STALE_SLOTS;
    const staleMs = row.stale_ms === null ? null : Number(row.stale_ms);
    const staleMin = staleMs === null ? null : Math.round(staleMs / 60_000);
    const consecutiveErrors = Number(row.consecutive_errors ?? 0);
    const window = adapter.maintenanceWindow;
    // 🛑 A vendor's window excuses a failure young enough to have been CAUSED by it — not one that
    // had been running long before it opened. Without this, a vendor dark for three hours would go
    // from 503 to 200 at 00:05 and back at 00:35, resolving and reopening a live incident for a
    // recovery that never happened.
    //
    // `staleMs - openForMs` is exactly how long BEFORE the window opened the last success was.
    // Both terms are integers off the same clock, so it is the identical number at every instant
    // inside the window and the verdict provably cannot flicker. The tolerance is one `budgetMin`
    // (15 min for Amber): the last poll before a window legitimately predates it by up to a slot,
    // plus slack for the ~3% of Vercel cron ticks that never fire. Deliberately not tighter — at
    // one slot the ordinary night has zero margin and a single late poll re-creates the nightly
    // page this whole mechanism exists to stop.
    const openForMs = window
      ? maintenanceWindowOpenForMs(window, new Date(Number(row.db_now_ms)))
      : null;
    const inMaintenance =
      openForMs !== null &&
      staleMs !== null &&
      staleMs - openForMs <= budgetMin * 60_000;
    const base = {
      rid: row.rid,
      name: row.name,
      vendor: row.vendor,
      staleMin,
      budgetMin,
      consecutiveErrors,
    };

    if (staleMin === null) {
      out.push({
        ...base,
        code: "device_never_polled",
        message: `${row.vendor} device ${row.rid} (${row.name}) has never recorded a successful poll.`,
      });
    } else if (
      staleMin > budgetMin ||
      consecutiveErrors >= DEVICE_FAILING_ERRORS
    ) {
      // One branch for "something is wrong", then one decision about whether it is NEWS. Splitting
      // the maintenance test across the two verdicts instead would let a device inside its vendor's
      // window fall through the stale branch into the failing one and alert anyway.
      if (window && inMaintenance) {
        out.push({
          ...base,
          code: "device_in_maintenance",
          message:
            `${row.vendor} device ${row.rid} (${row.name}) is unhealthy (last success ${staleMin} min ago, ` +
            `${consecutiveErrors} consecutive failures) but inside ${row.vendor}'s declared maintenance ` +
            `window (${window.start}–${window.end} ${window.timezone}, open ` +
            `${Math.round(openForMs! / 60_000)} min) — not ` +
            `alerting. The window closing is what re-arms this.`,
        });
      } else if (staleMin > budgetMin) {
        out.push({
          ...base,
          code: "device_poll_stale",
          message:
            `${row.vendor} device ${row.rid} (${row.name}) last succeeded ${staleMin} min ago — over ` +
            (declared !== undefined
              ? `its declared ${declared} min staleness budget.`
              : `${DEVICE_STALE_SLOTS}× its ${slot} min slot (${budgetMin} min).`),
        });
      } else {
        // The window where it is still inside its budget but visibly going under.
        out.push({
          ...base,
          code: "device_failing",
          message:
            `${row.vendor} device ${row.rid} (${row.name}) has failed ${consecutiveErrors} polls in a row ` +
            `(last success ${staleMin} min ago, still inside its ${budgetMin} min budget) — failing but not yet stale.`,
        });
      }
    } else {
      out.push({ ...base, code: "ok", message: "" });
    }
  }
  return out;
}

/** The subset worth telling someone about. */
export function unhealthy(all: DeviceHealth[]): DeviceHealth[] {
  return all.filter((d) => d.code !== "ok");
}

/**
 * The subset worth WAKING someone for — `unhealthy()` minus the states that are reports rather than
 * alarms. `device_never_polled` is a config problem (it would pin a monitor red forever on a device
 * that was added and never wired up); `device_in_maintenance` is a vendor doing what it said it
 * would. Both stay in the reported body; neither fails the check.
 */
export function alertable(all: DeviceHealth[]): DeviceHealth[] {
  return unhealthy(all).filter(
    (d) =>
      d.code !== "device_never_polled" && d.code !== "device_in_maintenance",
  );
}
