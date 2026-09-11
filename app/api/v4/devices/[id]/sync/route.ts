import { NextRequest, NextResponse } from "next/server";
import { CalendarDate } from "@internationalized/date";
import { requireDeviceAccess } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { devices as devicesTable } from "@/lib/db/planetscale/schema";
import { eq } from "drizzle-orm";
import { Device } from "@/lib/ids";
import { parseDateISO } from "@/lib/date-utils";
import { createPollCollector } from "@/lib/observations/poll-collector";
import { sessionManager } from "@/lib/session-manager";
import { getNextSessionId, formatSessionId } from "@/lib/session-id";
import {
  legFor,
  SYNCABLE_VENDORS,
  type ChunkAudit,
} from "@/lib/vendors/sync-legs";

/**
 * `POST /api/v4/devices/{id}/sync` — re-fetch a historical window from the vendor, for `liveone sync`.
 *
 * A JSON sibling of `/api/admin/amber-sync`, which is an SSE stream shaped for a browser terminal:
 * it cannot be read by a CLI, it is `/api/admin/*` so a `lo_cli_` bearer 404s at the Clerk edge, and
 * its numbers describe the wrong thing (see below). This route is the headless one.
 *
 * 🛑 **`published` is not `landed`, and this route deliberately reports only the first.** Publishing
 * is the near end of an asynchronous pipeline — the receiver writes to Postgres later, on its own
 * lane. The 2026-09-09 backfill reported `Rows inserted: 1008 / Success: YES` ten times in a row
 * while materialising **zero** rows, because `numRowsInserted` counts what the sync COMPARED, not
 * what any store accepted. So nothing here is called "inserted": `observations` is what went onto
 * the wire, and proving they landed is a separate READ of the serving store, which `liveone sync`
 * does after the lane drains.
 *
 * 🛑 **Chunked to the VENDOR's window, not to a number the caller invents.** Amber caps `/usage` and
 * `/prices` at 7 days; the admin route validated 30, so 8..30 failed at Amber with an opaque 422.
 * The caller passes the range it actually wants and this route walks it.
 *
 * Each chunk publishes on the **backfill** lane, so a multi-week replay cannot delay live minutely
 * ingest — the exact failure of 2026-09-09.
 *
 * The loop is bounded by WALL CLOCK, not by a chunk count, and a request that runs out returns
 * `done: false` with `nextStart`. A chunk count bounds nothing that matters: chunks vary by an order
 * of magnitude in how long the vendor takes to answer, and the failure of overrunning is a bare 504
 * with no report of the chunks that DID publish — work done and invisible, which is worse than
 * refusing. The caller resumes from `nextStart`; `liveone sync` does this in a loop.
 *
 * ## One verb, every backfillable vendor
 *
 * Everything above is the same whoever the vendor is, so it lives here and the per-vendor part lives
 * in `lib/vendors/sync-legs.ts`: Amber, Sigenergy and OpenElectricity are one concept — *one device,
 * one window, re-fetch what the vendor still holds*. They used to be three, and the two that were
 * not Amber were reachable only as `/api/cron/*-backfill` driven through the raw `liveone api`
 * escape hatch, which gives up the published/landed discipline this route exists to enforce.
 *
 * 🛑 **This route publishes; it does NOT rebuild derived tables.** It cannot: the budget is 45 s and
 * it must leave room to walk further windows, where a rebuild needs the lane to land first (which is
 * why `/api/cron/sigenergy-backfill` carries `maxDuration = 300` and a 60 s landing poll). The split
 * is publish (here) → verify landing (`liveone sync`, `--verify` on by default) → rebuild
 * (`liveone device recompute`). The unattended cron routes still recompute for themselves, because
 * nobody is watching them.
 */

export const maxDuration = 60;

/** Leave room for the response to serialise after the last chunk commits. */
const BUDGET_MS = 45_000;

const err = (message: string, status = 422) =>
  NextResponse.json({ error: message }, { status });

/** One vendor window's outcome. `observations` is what was PUBLISHED — see the 🛑 above. */
interface ChunkResult {
  start: string;
  end: string;
  days: number;
  observations: number;
  merged: number;
  durationMs: number;
  ok: boolean;
  /** Per action, why this window published what it did. Never empty on a chunk that ran. */
  audits: ChunkAudit[];
  error?: string;
}

/** Days from `a` to `b` inclusive. */
function daysBetween(a: CalendarDate, b: CalendarDate): number {
  return b.compare(a) + 1;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const uuid = Device.toUuidOrNull(id);
  if (!uuid) return err(`Invalid device id: ${id}`, 400);

  const [row] = await requirePlanetscaleDb()
    .select({
      // `rid` IS the integer handle the vendor/session layer calls `systemId`.
      rid: devicesTable.rid,
    })
    .from(devicesTable)
    .where(eq(devicesTable.id, uuid))
    .limit(1);
  // Unknown and not-readable are the same 404 here, as on the device aggregate: distinguishing them
  // would make this an existence oracle over other owners' devices.
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const systemId = row.rid;
  const auth = await requireDeviceAccess(request, systemId, {
    requireWrite: true,
  });
  if (auth instanceof NextResponse) return auth;

  // Everything vendor-specific comes off the registry view from here on, so there is one source of
  // truth for the vendor, the site id, the owner and the day offset.
  const device = auth.device;

  const leg = legFor(device.vendorType);
  if (!leg)
    return err(
      `sync is not implemented for vendor "${device.vendorType}" — a historical re-fetch ` +
        `needs a vendor history API, and only ${SYNCABLE_VENDORS.join(", ")} have one`,
    );

  const body = (await request.json().catch(() => null)) as {
    start?: unknown;
    end?: unknown;
    action?: unknown;
    dryRun?: unknown;
  } | null;
  if (!body) return err("Body must be JSON");

  // 🛑 An action names a HALF of a vendor's surface, so a vendor with one surface must refuse it
  // rather than ignore it. Ignoring would let `--action=usage` against Sigenergy look like it had
  // narrowed something, and silently fetch everything.
  let action: string | null;
  if (leg.actions === null) {
    if (body.action !== undefined)
      return err(
        `vendor "${device.vendorType}" has no action axis — it has a single historical ` +
          `surface, so drop --action`,
      );
    action = null;
  } else {
    action =
      body.action === undefined ? leg.defaultAction : String(body.action);
    if (action === null || !leg.actions.includes(action))
      return err(`action must be one of: ${leg.actions.join(", ")}`);
  }

  if (typeof body.start !== "string" || typeof body.end !== "string")
    return err("start and end are required, as YYYY-MM-DD local days");

  let first: CalendarDate;
  let last: CalendarDate;
  try {
    first = parseDateISO(body.start);
    last = parseDateISO(body.end);
  } catch {
    return err("start and end must be YYYY-MM-DD");
  }
  if (last.compare(first) < 0)
    return err(`end (${body.end}) is before start (${body.start})`);

  const dryRun = body.dryRun === true;

  const totalDays = daysBetween(first, last);

  // The windows this walk WOULD use, computed without touching the vendor.
  const plan: Array<{ start: string; end: string; days: number }> = [];
  for (let c = first; c.compare(last) <= 0; ) {
    const days = Math.min(leg.maxDays, daysBetween(c, last));
    plan.push({
      start: c.toString(),
      end: c.add({ days: days - 1 }).toString(),
      days,
    });
    c = c.add({ days });
  }

  const head = {
    device: {
      id,
      systemId,
      name: device.displayName,
      vendor: device.vendorType,
    },
    window: { start: first.toString(), end: last.toString(), days: totalDays },
    action,
    vendorMaxDays: leg.maxDays,
    lane: "backfill" as const,
    plan,
  };

  // Credentials and any vendor client are resolved ONCE, before the walk — a missing credential is
  // worth learning before committing to minutes of fetching, and it is a property of the device
  // rather than of any one window. A dry run stops right after it, having learned exactly that.
  const prepared = await leg.prepare(device);
  if ("error" in prepared) return err(prepared.error, prepared.status);

  // 🛑 A dry run touches NOTHING — no vendor fetch, no session rows, no publish. The credential and
  // vendor checks above have already run, which is the part worth learning before committing; going
  // on to fetch every window would take minutes, write a `ADMIN-DRYRUN` session per chunk, and then
  // discard the lot. "Report what would change and write nothing" is the harness's contract.
  if (dryRun)
    return NextResponse.json({
      ...head,
      dryRun: true,
      chunks: [],
      observations: 0,
      merged: 0,
      failed: 0,
      done: true,
      nextStart: null,
    });

  const chunks: ChunkResult[] = [];
  const deadline = Date.now() + BUDGET_MS;

  let cursor = first;
  let done = true;
  while (cursor.compare(last) <= 0) {
    // Checked BEFORE starting a chunk, never mid-chunk: a partially-run vendor window would
    // publish some of its observations and report none of them.
    if (chunks.length > 0 && Date.now() >= deadline) {
      done = false;
      break;
    }

    const days = Math.min(leg.maxDays, daysBetween(cursor, last));
    const chunkEnd = cursor.add({ days: days - 1 });
    const startedAt = Date.now();

    // One session and one collector PER CHUNK, so each window publishes on its own and a later
    // failure cannot strand the observations an earlier one already fetched.
    const sessionId = getNextSessionId();
    const session = await sessionManager.createSession({
      sessionLabel: formatSessionId(sessionId, 1),
      systemId,
      cause: "ADMIN",
      started: new Date(),
    });
    const collector = createPollCollector({ lane: "backfill" });

    let ok = true;
    let error: string | undefined;
    let audits: ChunkAudit[] = [];
    let response: unknown = null;
    try {
      const outcome = await prepared.run({
        device,
        start: cursor,
        end: chunkEnd,
        days,
        action,
        session,
        collector,
      });
      ok = outcome.ok;
      error = outcome.error;
      audits = outcome.audits;
      response = outcome.response;
    } catch (e) {
      ok = false;
      error = e instanceof Error ? e.message : String(e);
      // 🛑 A throw still gets an audit. `audits: []` on a chunk that ran would render as a bare
      // `0  failed` with nothing saying which half of the vendor refused.
      audits = [
        { action: action ?? "fetch", outcome: "failed", discovery: error },
      ];
    }

    const observations = collector.observations.length;
    const merged = collector.mergedCount;

    // Closing the session is what PUBLISHES — on both success and failure, so a window that failed
    // halfway still ships what it did fetch rather than discarding it.
    await sessionManager.updateSessionResult(
      session.id,
      {
        duration: Date.now() - startedAt,
        successful: ok,
        error: error ?? null,
        numRows: observations,
        response,
      },
      collector,
    );

    chunks.push({
      start: cursor.toString(),
      end: chunkEnd.toString(),
      days,
      observations,
      merged,
      durationMs: Date.now() - startedAt,
      ok,
      audits,
      ...(error ? { error } : {}),
    });

    cursor = chunkEnd.add({ days: 1 });

    // 🛑 Stop the walk on a failed window rather than carrying on. A vendor that has started
    // refusing (auth, rate limit, an outage) will refuse the rest too, and marching through 60 days
    // of it turns one legible error into sixty identical ones and a lot of empty sessions.
    if (!ok) {
      done = cursor.compare(last) > 0;
      break;
    }
  }

  return NextResponse.json({
    ...head,
    dryRun: false,
    chunks,
    observations: chunks.reduce((n, c) => n + c.observations, 0),
    merged: chunks.reduce((n, c) => n + c.merged, 0),
    failed: chunks.filter((c) => !c.ok).length,
    done,
    // Where a caller resumes. Null when the walk finished the window.
    nextStart: done ? null : cursor.toString(),
  });
}
