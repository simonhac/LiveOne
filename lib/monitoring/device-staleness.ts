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
 * budget (Amber declares 45 min) can fail every single poll for forty minutes and still look
 * perfectly healthy to the staleness check, because the cliff hasn't been reached. This is the
 * poll-side twin of the hub's `consecutive failed ticks` line — on 2026-09-11 the collector had two
 * self-recovering episodes hours before it died for good, and nothing was watching for them.
 */
export const DEVICE_FAILING_ERRORS = num(
  process.env.MONITOR_DEVICE_FAILING_ERRORS,
  5,
);

type DeviceHealthCode =
  | "ok"
  | "device_poll_stale"
  | "device_failing"
  | "device_never_polled";

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
  stale_min: string | null;
  consecutive_errors: number | null;
}

interface StaleAdapter {
  dataSource?: string;
  pollIntervalMinutes?: number;
  staleBudgetMinutes?: number;
}

/**
 * Evaluate every active POLL device's health.
 *
 * Push vendors (the Fly hub's deepsea/fusher sites) are skipped: they have no schedule to be late
 * against, so their freshness is the pusher's problem and is covered by their own external
 * heartbeats. Derived `helper` devices are skipped for the same reason — nothing polls them.
 */
export async function evaluateDeviceHealth(
  db: NonNullable<typeof planetscaleDb>,
): Promise<DeviceHealth[]> {
  const { VendorRegistry } = await import("@/lib/vendors/registry");
  const rows =
    (
      (await db.execute(sql`
        SELECT d.rid, d.name, d.vendor,
               (extract(epoch FROM (now() - ds.last_success_time)) / 60) AS stale_min,
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
    const staleMin =
      row.stale_min === null ? null : Math.round(Number(row.stale_min));
    const consecutiveErrors = Number(row.consecutive_errors ?? 0);
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
    } else if (consecutiveErrors >= DEVICE_FAILING_ERRORS) {
      // Deliberately `else if`: a device that is already stale is reported as stale, not twice.
      // This branch is the window where it is still inside its budget but visibly going under.
      out.push({
        ...base,
        code: "device_failing",
        message:
          `${row.vendor} device ${row.rid} (${row.name}) has failed ${consecutiveErrors} polls in a row ` +
          `(last success ${staleMin} min ago, still inside its ${budgetMin} min budget) — failing but not yet stale.`,
      });
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
