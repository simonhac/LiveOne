/**
 * Amber coverage-repair provider (Stage-2 backfill adapter for the generic framework).
 *
 * Cause of Amber gaps: the poll fetches `/usage` for "yesterday, 1 day" only and never re-fetches, but
 * Amber settles metered kwh/cost per NEM trading day with a variable lag → whole-AEST-day holes in the
 * energy+cost points (E1/kwh, E1/cost, B1/kwh, B1/cost). This provider re-fetches one gap-day via the
 * exact poll primitive `updateUsage(system, day, 1, …, collector)` — publishing through the shared
 * collector → QStash → receiver → agg_5m path. Gap DETECTION is the generic lib/coverage/find-gaps.
 */
import { parseDate } from "@internationalized/date";
import {
  fetchAmberUsage,
  groupRecordsByTime,
  buildRecordsMapFromAmber,
  storeRecordsLocally,
} from "@/lib/vendors/amber/client";
import { getSystemCredentials } from "@/lib/secure-credentials";
import type { AmberCredentials } from "@/lib/vendors/amber/types";
import type { SessionInfo } from "@/lib/point/point-manager";
import type { PollCollector } from "@/lib/observations/poll-collector";
import type { CoverageRepairProvider, DayRepair } from "@/lib/coverage/types";

/** Energy+cost on the E1 (import) and B1 (export) grid channels — the Amber points that gap. */
export const AMBER_USAGE_TAILS = [
  "E1/kwh",
  "E1/cost",
  "B1/kwh",
  "B1/cost",
] as const;

/**
 * Repair one Amber gap-day: UNCONDITIONALLY re-fetch `/usage` for that AEST day and store it through
 * the shared `collector`. Credentials are REQUIRED (always hits the Amber API). Returns `repaired` when
 * Amber returned data, `unsettled` when the API had nothing, or `error` on a failure.
 *
 * NB: we do NOT use `updateUsage` here — that's a quality-based SYNC that early-exits when the local
 * present intervals are already billable (client.ts:928), so it won't fill MISSING intervals on a
 * partially-present day. Coverage repair targets count-gaps, so we use the same unconditional
 * fetch→build→store path as the proven CSV/API backfill (`storeRecordsLocally` is idempotent).
 */
export async function repairAmberDay(
  systemId: number,
  day: string,
  credentials: AmberCredentials,
  session: SessionInfo,
  collector: PollCollector,
): Promise<DayRepair> {
  try {
    const firstDay = parseDate(day);
    const records = await fetchAmberUsage(credentials, firstDay, 1);
    if (records.length === 0)
      return { systemId, day, publishedRows: 0, status: "unsettled" };
    const batch = buildRecordsMapFromAmber(
      groupRecordsByTime(records),
      firstDay,
      1,
    );
    const result = await storeRecordsLocally(
      systemId,
      session,
      batch,
      "repair-coverage",
      collector,
    );
    const rows = result.numRowsInserted ?? 0;
    return {
      systemId,
      day,
      publishedRows: rows,
      status: rows > 0 ? "repaired" : "unsettled",
    };
  } catch (err) {
    return {
      systemId,
      day,
      publishedRows: 0,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export const amberProvider: CoverageRepairProvider<AmberCredentials> = {
  vendorType: "amber",
  cadenceMinutes: 30, // usage is 30-min → 48/day
  lookbackDays: 90,
  graceDays: 7,
  expectedPointTails: AMBER_USAGE_TAILS,
  needsCredentials: true,
  hasDerivedFlow: true,
  bucketOffsetMin: () => 600, // Amber/NEM are fixed UTC+10, no DST
  async prepare(system) {
    if (!system.ownerClerkUserId)
      return { ok: false, error: "no owner (Amber credentials required)" };
    const base = await getSystemCredentials(system.ownerClerkUserId, system.id);
    if (!base?.apiKey) return { ok: false, error: "no Amber credentials" };
    return {
      ok: true,
      ctx: { apiKey: base.apiKey, siteId: system.vendorSiteId || undefined },
    };
  },
  backfillDay(system, day, ctx, session, collector) {
    return repairAmberDay(system.id, day, ctx, session, collector);
  },
};
