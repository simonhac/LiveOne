/**
 * The Selectronic poll's fault leg: read the portal's Events page, retain what it says, and decide
 * whether it justifies going and reading the inverter's own logs.
 *
 * Kept out of `adapter.ts` because it is a second, independent request with its own failure mode.
 * The readings poll and the events poll must not be able to take each other down: a slow Events
 * page must not cost us the minute's readings, and a failed readings fetch must not stop us
 * retaining a fault the portal is reporting right now.
 */
import { sql } from "drizzle-orm";
import type { DeviceConfigView } from "@/lib/registry/device-config";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  fetchAccountTimezone,
  fetchPortalEvents,
  summarisePortalEvents,
  type PortalEventsResult,
} from "./portal-events";
import type { SelectronicFetchClient } from "./selectronic-client";
import {
  enqueueDiagnosticJob,
  ingestPortalEvents,
  type TriggerReason,
} from "@/lib/diagnostics/store";

/**
 * The whole fault leg's wall-clock budget, enforced by the caller.
 *
 * The minutely cron gives each device a bounded poll and this runs inside it. Two HTTP requests
 * plus the retention write must never be able to spend that budget after the readings have already
 * been fetched successfully — the readings are the thing the poll exists for.
 */
export const FAULT_LEG_BUDGET_MS = 10_000;

/**
 * What the Events page told us, and how much of it we can rely on.
 *
 * Three states, and the difference between them decides whether a fault may be reported CLEARED:
 *
 *   `off`         the device does not have portal event retention enabled. The portal contributes
 *                 nothing, and the vendor's own `fault_code` behaves exactly as it always has.
 *   `unavailable` enabled, but the page could not be read (login redirect, HTTP error, timeout, no
 *                 recognisable table). We know nothing this minute, and must not invent a clearance.
 *   `read`        the page was parsed. `parseComplete` is false when some rows were unreadable —
 *                 an ACTIVE fault we did see is still trustworthy, but the ABSENCE of one is not.
 */
type FaultSourceState = "off" | "unavailable" | "read";

export interface FaultObservation {
  state: FaultSourceState;
  reason?: string;
  /** Every row parsed. False means absence cannot be concluded from this observation. */
  parseComplete: boolean;
  /** The newest ACTIVE inverter event the portal is showing, if any. */
  activeCode: number | null;
  activeSince: Date | null;
  /** Newest Created across all inverter events, active or not — the sticky "last fault time". */
  lastFaultAt: Date | null;
  eventsSeen: number;
  unreadableRows: number;
  inserted: number;
  cleared: number;
  /** A diagnostic job was enqueued (or coalesced onto an open one). */
  enqueuedJobId: string | null;
}

const UNAVAILABLE = (reason: string): FaultObservation => ({
  state: "unavailable",
  reason,
  parseComplete: false,
  activeCode: null,
  activeSince: null,
  lastFaultAt: null,
  eventsSeen: 0,
  unreadableRows: 0,
  inserted: 0,
  cleared: 0,
  enqueuedJobId: null,
});

/**
 * Run database work with a server-side ceiling on it.
 *
 * 🛑 `withFaultLegBudget` in the adapter stops us WAITING; it cannot cancel a query already
 * executing or release the connection it holds. A statement blocked on a lock therefore goes on
 * occupying the shared pool long after the poll gave up, and enough of those starve ordinary
 * telemetry persistence. `SET LOCAL` is scoped to the transaction and released with it, so every
 * path that writes here goes through this — including the standalone enqueue, which is reached
 * exactly when the portal is already misbehaving.
 */
async function boundedTransaction<T>(
  work: (
    tx: Parameters<
      Parameters<ReturnType<typeof requirePlanetscaleDb>["transaction"]>[0]
    >[0],
  ) => Promise<T>,
): Promise<T> {
  return requirePlanetscaleDb().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
    return work(tx);
  });
}

/** Cached per client, alongside the session it was read with. */
const timezoneCache = new WeakMap<SelectronicFetchClient, string>();

/**
 * The last vendor `fault_code` this process saw, per device.
 *
 * 🛑 In-process and therefore LOSSY, deliberately, and it is worth being precise about what that
 * buys and what it does not. A transition within one process lifetime — the ordinary case, since
 * the minutely cron reuses its process — raises a trigger. A transition across a cold start does
 * not: the first sighting after a restart SEEDS the memo without firing, exactly as the portal
 * ingest baselines an unknown device, because the alternative is re-firing an acquisition for the
 * same persistent fault on every restart.
 *
 * 🛑 The memo is advanced only once the transition has been ACTED ON. Updating it at detection
 * time consumed the transition before it was durable: if the enqueue then failed, or the portal
 * request threw, the next poll would see the same nonzero code, compute no transition, and the
 * fault's inverter evidence would never be fetched — a warm-process failure mode entirely separate
 * from the cold-start limitation above.
 *
 * This is not the durable path and is not trying to be. The durable path is the portal's Events
 * page, whose transitions are computed against stored rows. This leg exists because the vendor
 * field can move in a minute where the portal page has not caught up.
 */
const lastVendorFaultCode = new Map<number, number>();

/** Test seam: the memo is module state, and a test that cannot clear it is a test that leaks. */
export function resetFaultCodeMemo(): void {
  lastVendorFaultCode.clear();
}

interface FaultCodeTransition {
  /** Null when there is nothing to act on — first sighting, or no change. */
  reason: TriggerReason | null;
  /** Call once the reason has been enqueued (or established as needing no enqueue). */
  commit: () => void;
}

function detectFaultCodeTransition(
  deviceRid: number,
  vendorFaultCode: number | null | undefined,
  observedAt: Date,
): FaultCodeTransition {
  // A MISSING field is not a zero. `numOrNull` yields null when the vendor omits `fault_code` or
  // sends something unparseable, and treating that as "no fault" would both fabricate a clearance
  // transition and corrupt the memo for the next real one.
  if (vendorFaultCode == null) return { reason: null, commit: () => {} };
  const current = vendorFaultCode;
  const commit = () => lastVendorFaultCode.set(deviceRid, current);
  const previous = lastVendorFaultCode.get(deviceRid);
  if (previous === undefined || previous === current)
    return { reason: null, commit };
  // Only a fault APPEARING is worth opening a session for. A clearance is reported by the portal
  // leg, whose Created/Cleared pair is the better record of it.
  if (!current) return { reason: null, commit };
  return {
    reason: {
      kind: "fault-code-changed",
      detail: `polled fault_code ${previous} → ${current}`,
      observedAt: observedAt.toISOString(),
    },
    commit,
  };
}

/**
 * Fetch, retain and evaluate the portal's event history for one device.
 *
 * Never throws: the caller is a poll, and a fault-history failure is a reduced observation, not a
 * failed poll.
 *
 * 🛑 Retention and enqueue run in ONE transaction. The trigger is computed by diffing the page
 * against what we already store, so storing the row CONSUMES the transition — if the enqueue then
 * failed, or the function were killed between the two, the next poll would see an unchanged page,
 * compute nothing, and the fault's inverter evidence would never be fetched.
 */
export async function observePortalEvents(
  device: DeviceConfigView,
  client: SelectronicFetchClient,
  vendorFaultCode: number | null | undefined,
): Promise<FaultObservation> {
  const observedAt = new Date();
  const autoAcquire = device.config?.diagnostics?.autoAcquire === true;
  const transition = detectFaultCodeTransition(
    device.id,
    vendorFaultCode,
    observedAt,
  );
  /** Enqueue the code transition on its own — the portal leg is not available to carry it. */
  const enqueueCodeTransitionAlone = async () => {
    if (!transition.reason) {
      transition.commit();
      return;
    }
    if (!autoAcquire) {
      // Nothing durable to lose: no job would be created either way, so the memo may advance.
      transition.commit();
      return;
    }
    await boundedTransaction((tx) =>
      enqueueDiagnosticJob(device.id, [transition.reason!], "trigger", tx),
    );
    transition.commit();
  };

  try {
    const fallbackZone = device.displayTimezone;
    let timezone = timezoneCache.get(client);
    if (!timezone) {
      timezone = await fetchAccountTimezone(client, fallbackZone);
      timezoneCache.set(client, timezone);
    }
    const result: PortalEventsResult = await fetchPortalEvents(
      client,
      device.vendorSiteId,
      timezone,
    );
    if (!result.available) {
      // 🛑 The Events page being unreadable is not a reason to drop a fault the POLL just reported.
      // The two sources fail independently, and the minute an inverter faults is exactly the minute
      // the portal is most likely to be unreachable.
      await enqueueCodeTransitionAlone();
      return UNAVAILABLE(result.reason);
    }

    const summary = summarisePortalEvents(result.events);
    const outcome = await boundedTransaction(async (tx) => {
      const ingest = await ingestPortalEvents(
        device.id,
        result.events,
        timezone!,
        result.fetchedAt,
        tx,
      );
      const reasons = transition.reason
        ? [transition.reason, ...ingest.reasons]
        : ingest.reasons;
      let enqueuedJobId: string | null = null;
      if (autoAcquire && reasons.length) {
        const { jobId } = await enqueueDiagnosticJob(
          device.id,
          reasons,
          // A first-ever ingest whose only reason is an ACTIVE fault is still a baseline run; the
          // label records why we went, not how urgent it was.
          ingest.baseline ? "baseline" : "trigger",
          tx,
        );
        enqueuedJobId = jobId;
      }
      return { ingest, enqueuedJobId };
    });
    // The transaction committed, so the transition has been acted on and the memo may advance.
    transition.commit();

    return {
      state: "read",
      // Rows we could not read mean the page's ABSENCES cannot be trusted this minute.
      parseComplete: result.unreadableRows === 0,
      ...summary,
      eventsSeen: result.events.length,
      unreadableRows: result.unreadableRows,
      inserted: outcome.ingest.inserted,
      cleared: outcome.ingest.cleared,
      enqueuedJobId: outcome.enqueuedJobId,
    };
  } catch (error) {
    // 🛑 The memo is NOT committed here. Leaving it at its previous value is what makes the next
    // poll re-detect the same transition and try again.
    return UNAVAILABLE(
      error instanceof Error
        ? `Event history unavailable: ${error.message}`
        : "Event history unavailable.",
    );
  }
}

/** The observation for a device with the portal leg switched off. */
export const faultLegOff = (): FaultObservation => ({
  state: "off",
  parseComplete: true,
  activeCode: null,
  activeSince: null,
  lastFaultAt: null,
  eventsSeen: 0,
  unreadableRows: 0,
  inserted: 0,
  cleared: 0,
  enqueuedJobId: null,
});

/**
 * Resolve the two fault points from everything we know.
 *
 * 🛑 A vendor field that is ABSENT is not a zero. `numOrNull` yields null when select.live omits
 * `fault_code`/`fault_ts` or sends something unparseable, and on a device with the portal leg off
 * that is the only source there is — so the answer is null (write nothing, retain what we had),
 * never a manufactured clearance. The pre-existing adapter skipped those fields for the same
 * reason.
 *
 * 🛑 `faultCode` is **0**, not null, whenever a source can actually establish that no fault is
 * active. A null leaves the previous reading standing as the latest value for ever — which is how
 * a cleared fault appears permanent. That includes the DEFAULT case: a device with the portal leg
 * off still publishes the vendor's own zero, exactly as it did before this feature existed.
 *
 * Null is reserved for "we genuinely do not know this minute": the Events page was enabled but
 * unreadable, or only partly readable and showed no active fault. Writing a zero there would
 * manufacture a clearance out of a network error.
 *
 * 🛑 `faultTsMs` is the LAST KNOWN fault time and is deliberately sticky: it survives clearance, so
 * a fault that came and went between two polls still leaves a trace. It uses the portal's
 * **Created**, never its Cleared — a clearance is when the fault ended — and it is in EPOCH
 * MILLISECONDS, which is what the point declares. The vendor field is Unix seconds; feeding it
 * through unconverted (as this did until the event work) put every value in 1970.
 */
export function resolveFaultPoints(
  vendorFaultCode: number | null | undefined,
  vendorFaultTsSeconds: number | null | undefined,
  observation: FaultObservation,
): { faultCode: number | null; faultTsMs: number | null } {
  const fresh =
    vendorFaultCode && vendorFaultCode !== 0 ? vendorFaultCode : null;
  const vendorTsMs = vendorFaultTsSeconds ? vendorFaultTsSeconds * 1000 : null;

  // A fresh nonzero code from the readings wins: it is the inverter's own current answer, sampled
  // this minute.
  if (fresh !== null) {
    const candidates = [
      vendorTsMs,
      observation.lastFaultAt?.getTime() ?? null,
    ].filter((v): v is number => v !== null);
    return {
      faultCode: fresh,
      faultTsMs: candidates.length ? Math.max(...candidates) : null,
    };
  }

  if (observation.state === "off")
    // Vendor-only, and unchanged from the behaviour that predates this feature: a reported zero
    // clears, an absent field writes nothing.
    return {
      faultCode: vendorFaultCode == null ? null : 0,
      faultTsMs: vendorFaultTsSeconds == null ? null : (vendorTsMs ?? 0),
    };

  if (observation.state === "unavailable")
    return { faultCode: null, faultTsMs: vendorTsMs };

  const lastFaultMs = observation.lastFaultAt?.getTime() ?? null;
  const candidates = [vendorTsMs, lastFaultMs].filter(
    (v): v is number => v !== null,
  );
  const faultTsMs = candidates.length ? Math.max(...candidates) : 0;

  if (observation.activeCode !== null)
    // An active fault we DID see is trustworthy even from a partial parse.
    return { faultCode: observation.activeCode, faultTsMs };

  // No active fault — but only a COMPLETE parse can conclude that. With unreadable rows the one we
  // could not read might be the active one.
  return {
    faultCode: observation.parseComplete ? 0 : null,
    faultTsMs: observation.parseComplete
      ? faultTsMs
      : (vendorTsMs ?? lastFaultMs),
  };
}
