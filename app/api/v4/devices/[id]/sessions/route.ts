import { NextRequest, NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";
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
 * `POST` mints one; `GET` lists the recent ones. For `liveone session create` / `session list`.
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

  const url = new URL(request.url);
  const raw = Number(url.searchParams.get("limit") ?? 20);
  const limit = Number.isFinite(raw)
    ? Math.min(Math.max(Math.trunc(raw), 1), MAX_LIMIT)
    : 20;
  const cause = url.searchParams.get("cause");

  const db = requirePlanetscaleDb();
  const rows = await db
    .select({
      id: sessionsTable.id,
      label: sessionsTable.sessionLabel,
      cause: sessionsTable.cause,
      successful: sessionsTable.successful,
      numRows: sessionsTable.numRows,
      createdAt: sessionsTable.createdAt,
    })
    .from(sessionsTable)
    .where(eq(sessionsTable.deviceRid, device.rid))
    .orderBy(desc(sessionsTable.createdAt))
    .limit(limit);

  // The manifest is deliberately NOT in the list: it is unbounded, and a list is for finding the
  // id you then `show`. Filtering by cause happens here rather than in SQL for the same reason the
  // limit is capped — this endpoint answers "which session", not "give me everything".
  return NextResponse.json({
    device: { id, systemId: device.rid },
    sessions: rows
      .filter((r) => !cause || r.cause === cause)
      .map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
  });
}
