import { NextRequest, NextResponse } from "next/server";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { requireDeviceAccess } from "@/lib/api-auth";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  devices as devicesTable,
  sessions as sessionsTable,
} from "@/lib/db/planetscale/schema";
import { Device } from "@/lib/ids";

/**
 * `/api/v4/devices/{id}/sessions` — the provenance record an import is filed under.
 *
 * `POST` mints one; `GET` lists them. For `liveone session create` / `session list`.
 *
 * `GET` has two modes. Without a window it is the "which session" list: newest first, `limit`
 * (default 20, max 200). With `since` + `until` it is the evidence read: every session created in
 * `[since, until)`, oldest first, pages of up to 5000 on an opaque `(created_at, id)` `cursor`
 * (`nextCursor`, null on the last page). Both modes take `cause=` and `failed=true`, filtered in
 * SQL. Each row carries `duration`, `errorCode`, `error`, and `createdAt` at µs precision.
 *
 * 🛑 **This writes the row DIRECTLY, unlike `sessionManager.createSession`.** That helper does not
 * touch the database: it stashes the session in an in-process map and the row reaches Postgres via
 * the queue when `updateSessionResult` closes it. Correct for a poll — the session and its readings
 * arrive together, as one message — and useless here, because the very next thing that happens is a
 * separate HTTP request (often several, one per chunk, on another lambda) that has to look this
 * session up by id. A provenance record that is not durable the instant it is minted is not one.
 *
 * 🛑 **`label` and `manifest` are both required.** A session exists here for exactly one reason: so
 * that a row written on an operator's say-so can still answer "where did this come from?" years
 * later. `derive-power.ts` is what makes that answer load-bearing — it writes a vendor's own
 * late-arriving samples as `good` rather than inventing a provenance marker, because "which rows
 * arrived this way is answerable from `session_id`". An unlabelled session with no manifest keeps
 * the foreign key and discards the answer, which is the failure this verb was added to prevent.
 * The manifest goes in `sessions.response`, which already means "what the upstream said" — the sync
 * route archives its `SyncChunkResult.response` there verbatim.
 */

export const maxDuration = 30;

const err = (message: string, status = 422) =>
  NextResponse.json({ error: message }, { status });

/** A cap on `GET`, so an unbounded list cannot become the expensive way to read one row. */
const MAX_LIMIT = 200;
/** A windowed page's cap — the window, not the page, is what bounds a windowed read. */
const MAX_WINDOWED_LIMIT = 5000;
const MAX_WINDOW_MS = 31 * 86_400_000;
const US_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** Opaque (created_at µs, id) keyset — base64url JSON, so its shape is not a contract. */
const encodeCursor = (t: string, id: string) =>
  Buffer.from(JSON.stringify([t, id])).toString("base64url");

function decodeCursor(raw: string): { t: string; id: string } | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, "base64url").toString());
    if (
      Array.isArray(v) &&
      v.length === 2 &&
      typeof v[0] === "string" &&
      US_INSTANT.test(v[0]) &&
      typeof v[1] === "string" &&
      v[1].length > 0
    )
      return { t: v[0], id: v[1] };
  } catch {
    // fall through
  }
  return null;
}

async function resolveDevice(id: string) {
  const uuid = Device.toUuidOrNull(id);
  if (!uuid) return null;
  const db = requirePlanetscaleDb();
  const [row] = await db
    .select({ rid: devicesTable.rid })
    .from(devicesTable)
    .where(eq(devicesTable.id, uuid))
    .limit(1);
  return row ?? null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const device = await resolveDevice(id);
  // Unknown and not-readable collapse to one 404, as on /sync and /import.
  if (!device)
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  const auth = await requireDeviceAccess(request, device.rid, {
    requireWrite: true,
  });
  if (auth instanceof NextResponse) return auth;

  const body = (await request.json().catch(() => null)) as {
    label?: unknown;
    manifest?: unknown;
    cause?: unknown;
    dryRun?: unknown;
  } | null;
  if (!body) return err("Body must be JSON");

  if (typeof body.label !== "string" || body.label.trim().length === 0)
    return err(
      "label is required — it is how a human finds this import again, and there is no " +
        "useful default for 'why did these rows appear'",
    );
  const label = body.label.trim();

  if (body.manifest === undefined || body.manifest === null)
    return err(
      "manifest is required — it is the record of WHERE the data came from. Name the source " +
        "(archive directory and its checksums), the mapping applied, and the tool that built it.",
    );

  const id7 = uuidv7();
  const now = new Date();
  const summary = {
    session: {
      id: id7,
      deviceRid: device.rid,
      label,
      cause: "ADMIN" as const,
      createdAt: now.toISOString(),
    },
  };
  if (body.dryRun === true)
    return NextResponse.json({ ...summary, dryRun: true, created: false });

  const db = requirePlanetscaleDb();
  await db.insert(sessionsTable).values({
    id: id7,
    sessionLabel: label,
    deviceRid: device.rid,
    cause: "ADMIN",
    // Open: nothing has been imported under it yet. `numRows` is incremented by each import that
    // cites it, so the closed record says how much it accounted for.
    duration: 0,
    numRows: 0,
    successful: null,
    response: body.manifest as object,
    createdAt: now,
  });

  console.log(
    `[Session] created ${id7} for device ${device.rid}: ${JSON.stringify(label)}`,
  );
  return NextResponse.json({ ...summary, dryRun: false, created: true });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const device = await resolveDevice(id);
  if (!device)
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  const auth = await requireDeviceAccess(request, device.rid);
  if (auth instanceof NextResponse) return auth;

  const sp = new URL(request.url).searchParams;
  const cause = sp.get("cause");
  const failed = sp.get("failed") === "true";
  const since = sp.get("since");
  const until = sp.get("until");
  const cursorRaw = sp.get("cursor");
  const windowed = since !== null || until !== null;

  // Two modes. WINDOWLESS is the original "which session" list: newest first, capped at 200.
  // WINDOWED is the evidence read — every session whose `created_at` falls in [since, until),
  // oldest first, paged on a (created_at, id) keyset so a burst of same-instant sessions cannot
  // straddle a page boundary and be lost.
  let sinceIso: string | null = null;
  let untilIso: string | null = null;
  if (windowed) {
    const sMs = Date.parse(since ?? "");
    const uMs = Date.parse(until ?? "");
    if (!Number.isFinite(sMs) || !Number.isFinite(uMs))
      return err("since and until are both required ISO timestamps", 400);
    if (uMs <= sMs) return err("until must be after since", 400);
    if (uMs - sMs > MAX_WINDOW_MS)
      return err("the window is at most 31 days", 400);
    sinceIso = new Date(sMs).toISOString();
    untilIso = new Date(uMs).toISOString();
  } else if (cursorRaw !== null) {
    return err("cursor pages a since/until window; pass both", 400);
  }

  const max = windowed ? MAX_WINDOWED_LIMIT : MAX_LIMIT;
  const raw = Number(sp.get("limit") ?? (windowed ? MAX_WINDOWED_LIMIT : 20));
  const limit = Number.isFinite(raw)
    ? Math.min(Math.max(Math.trunc(raw), 1), max)
    : 20;

  let cursor: { t: string; id: string } | null = null;
  if (cursorRaw !== null) {
    cursor = decodeCursor(cursorRaw);
    if (!cursor) return err("cursor is not one this server issued", 400);
  }

  const createdAtUs = sql<string>`to_char(${sessionsTable.createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const db = requirePlanetscaleDb();
  const rows = await db
    .select({
      id: sessionsTable.id,
      label: sessionsTable.sessionLabel,
      cause: sessionsTable.cause,
      successful: sessionsTable.successful,
      duration: sessionsTable.duration,
      errorCode: sessionsTable.errorCode,
      error: sessionsTable.error,
      numRows: sessionsTable.numRows,
      createdAt: createdAtUs,
    })
    .from(sessionsTable)
    .where(
      and(
        eq(sessionsTable.deviceRid, device.rid),
        // In SQL, not after the LIMIT: filtering the newest N in JS returned fewer than N (often
        // none) whenever the wanted cause was not among the newest N sessions of every cause.
        cause ? eq(sessionsTable.cause, cause) : undefined,
        failed ? eq(sessionsTable.successful, false) : undefined,
        sinceIso
          ? sql`${sessionsTable.createdAt} >= ${sinceIso}::timestamp`
          : undefined,
        untilIso
          ? sql`${sessionsTable.createdAt} < ${untilIso}::timestamp`
          : undefined,
        cursor
          ? sql`(${sessionsTable.createdAt}, ${sessionsTable.id}) > (${cursor.t}::timestamp, ${cursor.id})`
          : undefined,
      ),
    )
    .orderBy(
      ...(windowed
        ? [asc(sessionsTable.createdAt), asc(sessionsTable.id)]
        : [desc(sessionsTable.createdAt)]),
    )
    .limit(windowed ? limit + 1 : limit);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  // The manifest (`sessions.response`) is deliberately NOT in the list: it is unbounded, and a list
  // is for finding the id you then `show`.
  return NextResponse.json({
    device: { id, systemId: device.rid },
    sessions: page,
    ...(windowed
      ? {
          window: { since: sinceIso, until: untilIso },
          nextCursor:
            rows.length > limit && last
              ? encodeCursor(last.createdAt, last.id)
              : null,
        }
      : {}),
  });
}
