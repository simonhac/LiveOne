/**
 * Per-vendor legs for `POST /api/v4/devices/{id}/sync` — the historical re-fetch behind `liveone sync`.
 *
 * The route owns everything that is the same for every vendor: the window, the chunk walk bounded by
 * wall clock, one session + one collector per chunk, publishing on session close, and `nextStart`
 * resumption. A leg owns only the part that is genuinely the vendor's — what to call, and how to say
 * why a window published what it did.
 *
 * ## Why this exists
 *
 * `liveone sync` was Amber-only, so recovering a Sigenergy or OpenElectricity gap meant driving
 * `/api/cron/*-backfill` through the raw `liveone api` escape hatch. That works and it throws away the
 * one property the sync verb exists to provide: PUBLISHED and LANDED reported as separate numbers. On
 * 2026-09-09 an Amber backfill reported `Rows inserted: 1008 / Success: YES` ten times in a row while
 * materialising zero rows; a cron route driven by hand reports the near end of the pipeline and nothing
 * reads the serving store back. The three vendors are one concept — *one device, one window, re-fetch
 * what the vendor still holds* — so they get one verb.
 *
 * ## What a leg must not do
 *
 * 🛑 **A leg publishes; it does not rebuild derived tables.** The route's budget is 45 s and it must
 * leave room to walk further windows, so it cannot also wait for the backfill lane to land and then
 * recompute — which is exactly why `/api/cron/sigenergy-backfill` needs `maxDuration = 300` and a 60 s
 * landing poll. The honest split is publish (here) → verify landing (`liveone sync`, `--verify` on by
 * default) → rebuild (`liveone device recompute`). A leg that quietly recomputed would be a third of a
 * rebuild that nobody asked for and that the caller cannot see.
 *
 * The unattended cron routes keep doing their own recompute, because nobody is watching them.
 */
import type { CalendarDate } from "@internationalized/date";
import type { SessionInfo } from "@/lib/point/point-manager";
import type { PollCollector } from "@/lib/observations/poll-collector";
import type { DeviceConfigView } from "@/lib/registry/device-config";
import { calendarDateToUnixRange } from "@/lib/date-utils";
import { getDeviceCredentials } from "@/lib/secure-credentials";
import {
  AMBER_MAX_SYNC_DAYS,
  updateUsage,
  updateForecasts,
} from "@/lib/vendors/amber/client";
import type { AmberSyncResult } from "@/lib/vendors/amber/types";
import { SigenergyClient } from "@/lib/vendors/sigenergy/sigenergy-client";
import { backfillEnergyRange } from "@/lib/vendors/sigenergy/statistics";
import type { SigenergyCredentials } from "@/lib/vendors/sigenergy/types";
import { backfillRange } from "@/lib/vendors/openelectricity/backfill";
import { isNemRegion } from "@/lib/vendors/openelectricity/types";

/**
 * Where one vendor window stopped, and so WHY it published what it did.
 *
 * 🛑 `observations: 0` is not one outcome, it is three, and the number cannot tell them apart.
 * On 2026-09-10 a recovery run over 2026-06-12 → 2026-07-06 published 0 and a control re-run of the
 * already-recovered 2026-07-07 → 2026-07-13 published 0, for opposite reasons — the first because
 * Amber has no data that far back, the second because we already held it and the vendor was never
 * called. Separating them meant minting a prod database role to read `discovery` out of
 * `sessions.response`, which is an absurd cost for "did the vendor have anything?" and exactly the
 * class of unreadable number this route exists to abolish.
 */
export type ChunkOutcome =
  /** Records were fetched and published. */
  | "published"
  /** Local already holds complete data for the window. THE VENDOR WAS NOT CALLED. */
  | "already-held"
  /** The vendor answered, with nothing for this window. */
  | "vendor-empty"
  /** The vendor had records, none better than what is already stored. */
  | "nothing-superior"
  /** The window errored; see `error`. */
  | "failed"
  /** The result's shape is not one this classifier recognises. Say so; do not pick a plausible one. */
  | "unknown";

/** What the vendor path said about itself, carried back so a zero explains itself. */
export interface ChunkAudit {
  /** The half of the vendor's surface this entry describes — `usage`, `pricing`, `energy`, `grid`. */
  action: string;
  outcome: ChunkOutcome;
  /** The most specific thing known about this window, in the vendor path's own words. */
  discovery?: string;
}

/** One window of one device, as a leg is asked to fetch it. */
export interface SyncChunkArgs {
  device: DeviceConfigView;
  /** Inclusive local days. `days` is `end - start + 1`, precomputed by the route. */
  start: CalendarDate;
  end: CalendarDate;
  days: number;
  /** The selected action, or `null` for a vendor with no action axis. */
  action: string | null;
  session: SessionInfo;
  collector: PollCollector;
}

export interface SyncChunkResult {
  ok: boolean;
  error?: string;
  /** Never empty on a window that ran: a zero must always be able to explain itself. */
  audits: ChunkAudit[];
  /** Archived verbatim into `sessions.response`. */
  response: unknown;
}

/** A refusal a leg can raise before the walk starts — surfaced as this status, not as a failed chunk. */
export interface LegRefusal {
  error: string;
  status: number;
}

export type LegRunner = (args: SyncChunkArgs) => Promise<SyncChunkResult>;

export interface SyncLeg {
  vendor: string;
  /**
   * The vendor's own answer window, in local days. The caller passes the range it wants and the
   * route walks it in chunks of at most this — never a number the caller invents.
   */
  maxDays: number;
  /**
   * The action values this vendor understands, or `null` where the vendor has no such axis. Amber
   * answers `/usage` and `/prices` separately; Sigenergy and OpenElectricity each have one surface,
   * so an `action` for them names nothing and is refused rather than silently ignored.
   */
  actions: readonly string[] | null;
  defaultAction: string | null;
  /**
   * Resolve credentials and build whatever client the walk will reuse. Runs ONCE, before the first
   * chunk — a missing credential is worth learning before committing to minutes of fetching, and it
   * is a property of the device rather than of any one window.
   */
  prepare(device: DeviceConfigView): Promise<LegRefusal | { run: LegRunner }>;
}

// ---------------------------------------------------------------------------
// Amber
// ---------------------------------------------------------------------------

/**
 * Classify by HOW FAR the audit got, not by matching its prose. `updateUsage`/`updateForecasts`
 * push exactly one entry per stage they reach and stop at the first early exit, so the stage COUNT
 * is the exit point — a structural fact, where `discovery` is human text that may be reworded.
 */
function classifyAmberAudit(audit: AmberSyncResult): ChunkOutcome {
  if (!audit.success) return "failed";
  // Stage 4 is the only stage that STORES, so reaching it is what "published" means. Keyed off the
  // count reaching 4 rather than a bare `default:`, so an audit with no stages at all — which
  // should be impossible, stage 1 always runs — cannot fall through into the happy answer.
  if (audit.stages.length >= 4) return "published";
  switch (audit.stages.length) {
    case 1:
      return "already-held";
    case 2:
      return "vendor-empty";
    case 3:
      return "nothing-superior";
    default:
      return "unknown";
  }
}

function amberAudit(audit: AmberSyncResult): ChunkAudit {
  return {
    action: audit.action,
    outcome: classifyAmberAudit(audit),
    // The LAST stage's discovery, which is the one describing why the walk stopped. An earlier
    // stage's text would describe a step that then continued.
    ...(audit.stages.at(-1)?.discovery
      ? { discovery: audit.stages.at(-1)!.discovery }
      : {}),
  };
}

const amberLeg: SyncLeg = {
  vendor: "amber",
  maxDays: AMBER_MAX_SYNC_DAYS,
  actions: ["usage", "pricing", "both"],
  defaultAction: "both",

  async prepare(device) {
    // Credentials from Clerk privateMetadata, the same source the minutely poll uses. The DEVICE's
    // `vendorSiteId` wins over the credential's, exactly as the poll path does — the credential's
    // siteId is optional in the Add Device form, so for many devices it is simply absent.
    const stored = device.ownerClerkUserId
      ? await getDeviceCredentials(device.ownerClerkUserId, device.id)
      : null;
    if (!stored?.apiKey)
      return {
        error: `No Amber credentials configured for system ${device.id}`,
        status: 400,
      };
    const credentials = {
      apiKey: stored.apiKey,
      siteId: device.vendorSiteId || stored.siteId,
    };

    return {
      run: async ({ device: d, start, days, action, session, collector }) => {
        const audits: AmberSyncResult[] = [];
        let ok = true;
        let error: string | undefined;

        if (action === "usage" || action === "both") {
          const audit = await updateUsage(
            d.id,
            start,
            days,
            credentials,
            session,
            false,
            collector,
          );
          audits.push(audit);
          if (!audit.success) {
            ok = false;
            error = audit.summary.error ?? "usage sync failed";
          }
        }
        if (action === "pricing" || action === "both") {
          const audit = await updateForecasts(
            d.id,
            start,
            days,
            credentials,
            session,
            false,
            collector,
          );
          audits.push(audit);
          if (!audit.success) {
            ok = false;
            error = audit.summary.error ?? "pricing sync failed";
          }
        }

        return {
          ok,
          ...(error ? { error } : {}),
          audits: audits.map(amberAudit),
          response: audits,
        };
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Sigenergy
// ---------------------------------------------------------------------------

/** `backfillEnergyRange` wants `YYYYMMDD`, station-local. */
const ymd = (d: CalendarDate) => d.toString().replace(/-/g, "");

/**
 * Sigenergy's `statistics/energy` is per calendar day, so a chunk is only a loop bound — there is no
 * vendor cap to respect. Seven days keeps one request inside the route's 45 s budget with room for
 * the response to serialise, which is what makes `nextStart` resumption meaningful rather than a
 * theoretical branch that only fires on a timeout.
 */
const SIGEN_CHUNK_DAYS = 7;

const sigenergyLeg: SyncLeg = {
  vendor: "sigenergy",
  maxDays: SIGEN_CHUNK_DAYS,
  actions: null,
  defaultAction: null,

  async prepare(device) {
    if (!device.vendorSiteId)
      return {
        error: `System ${device.id} has no Sigenergy station id (vendorSiteId)`,
        status: 400,
      };
    if (!device.ownerClerkUserId)
      return {
        error: `System ${device.id} has no owner, and Sigenergy requires credentials`,
        status: 400,
      };
    // getDeviceCredentials swallows its own failures and returns null, so this cannot throw.
    const credentials = (await getDeviceCredentials(
      device.ownerClerkUserId,
      device.id,
    )) as SigenergyCredentials | null;
    if (!credentials?.username || !credentials?.password)
      return {
        error: `No Sigenergy credentials configured for system ${device.id}`,
        status: 400,
      };

    const client = new SigenergyClient({
      username: credentials.username,
      password: credentials.password,
      region: credentials.region ?? "aus",
    });
    const stationId = device.vendorSiteId;

    return {
      run: async ({ device: d, start, end, session, collector }) => {
        const result = await backfillEnergyRange({
          client,
          systemId: d.id,
          stationId,
          startDate: ymd(start),
          endDate: ymd(end),
          tzOffsetMin: d.timezoneOffsetMin,
          session,
          collector,
        });

        const written = result.days.reduce((n, x) => n + x.readingsWritten, 0);
        const derived = result.days.reduce((n, x) => n + x.derivedWritten, 0);
        const empty = result.days.every((x) => x.empty);

        // 🛑 `vendor-empty` is claimed only when the vendor answered for EVERY day and every answer
        // was empty. A partially-empty range published something, and calling that "the vendor has
        // nothing" is the misreading this vocabulary exists to prevent.
        const outcome: ChunkOutcome = !result.days.length
          ? "unknown"
          : written > 0
            ? "published"
            : empty
              ? "vendor-empty"
              : "nothing-superior";

        return {
          ok: result.errors.length === 0,
          ...(result.errors.length ? { error: result.errors.join("; ") } : {}),
          audits: [
            {
              action: "energy",
              outcome,
              discovery:
                `${result.days.length} day(s): ${written} energy reading(s), ` +
                `${derived} derived power/SoC row(s)` +
                (empty ? ", every day empty at the vendor" : ""),
            },
          ],
          response: result,
        };
      },
    };
  },
};

// ---------------------------------------------------------------------------
// OpenElectricity
// ---------------------------------------------------------------------------

/**
 * `backfillRange` already chunks internally at ~3.47 days (its own per-request interval cap) and
 * retries rate limits with backoff, so this bound exists only to keep ONE route request inside the
 * 45 s budget.
 */
const OE_CHUNK_DAYS = 3;

const openelectricityLeg: SyncLeg = {
  vendor: "openelectricity",
  maxDays: OE_CHUNK_DAYS,
  actions: null,
  defaultAction: null,

  async prepare(device) {
    const region = device.vendorSiteId;
    if (!isNemRegion(region))
      return {
        error: `System ${device.id} has no valid NEM region (vendorSiteId="${region}")`,
        status: 400,
      };
    const network = (device.metadata as { network?: string } | null)?.network;

    return {
      run: async ({ device: d, start, end, session, collector }) => {
        // Inclusive end-of-day, at the DEVICE's own offset rather than a hardcoded AEST — the region
        // devices all sit at +10 today, and a constant that happens to be right is still a constant.
        const [startSec] = calendarDateToUnixRange(start, d.timezoneOffsetMin);
        const [, endSec] = calendarDateToUnixRange(end, d.timezoneOffsetMin);

        const result = await backfillRange({
          systemId: d.id,
          region,
          network,
          dateStart: new Date(startSec * 1000),
          dateEnd: new Date(endSec * 1000),
          session,
          collector,
          // 🛑 Never the fleet-wide `aggregateRange` from here. Rebuilding derived rows is
          // `liveone device recompute`'s job — see the module header.
          aggregate: null,
        });

        return {
          ok: result.errors.length === 0,
          ...(result.errors.length ? { error: result.errors.join("; ") } : {}),
          audits: [
            {
              action: "grid",
              outcome:
                result.intervalsIngested > 0 ? "published" : "vendor-empty",
              discovery:
                `${result.chunks} vendor request(s): ${result.intervalsIngested} interval(s)` +
                (result.rateLimited
                  ? `, ${result.rateLimited} rate-limited`
                  : ""),
            },
          ],
          response: result,
        };
      },
    };
  },
};

// ---------------------------------------------------------------------------

const LEGS: Record<string, SyncLeg> = {
  amber: amberLeg,
  sigenergy: sigenergyLeg,
  openelectricity: openelectricityLeg,
};

/** The leg for a vendor, or null where that vendor has no historical re-fetch path at all. */
export function legFor(vendor: string): SyncLeg | null {
  return LEGS[vendor] ?? null;
}

/** Vendors `liveone sync` can re-fetch, for an error message that names the alternatives. */
export const SYNCABLE_VENDORS = Object.keys(LEGS);
