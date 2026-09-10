import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import {
  transferOwnership,
  TransferError,
  parseIdList,
  parseShareBack,
  type GrantRole,
} from "@/lib/ownership/transfer";

/**
 * `POST /api/v4/ownership/transfer` — move devices/areas/dashboards to a new owner, and grant the
 * outgoing owner (or anyone else) back onto the dashboards, in ONE transaction.
 *
 *   POST { toUserId, devices?: [dv_…], areas?: [ar_…], dashboards?: [db_…],
 *          shareBackTo?: [user_… | {userId, role}], role?: "viewer"|"admin", dryRun?, force? }
 *     → 200 { transferred: [...], grantsWritten: [...], warnings: [...] }
 *     · 422 { error, detail? } — NOTHING applied
 *
 * 🛑 **Why this exists as one route rather than three PATCHes.** Nothing else in the API writes an
 * owner column at all: `devices/[id]` is GET-only, and the `areas`/`dashboards` PATCHes take name,
 * slug and placement but never ownership. The only pre-existing owner writer is
 * `PATCH /api/admin/devices/{systemId}/admin-settings`, which is `/api/admin/*` and therefore
 * unreachable with a CLI token. So ownership was browser-only and per-device, and a site is never
 * one device.
 *
 * 🛑 **Why the share-back is in the same call.** Read access is derived from ownership plus
 * dashboard grants, so the instant ownership moves, the outgoing owner loses access — and granting
 * is itself an owner-side mutation, so doing it afterwards can require the access you just gave
 * away. `lib/ownership/transfer.ts` explains the full reasoning; the route's job is to keep the two
 * halves inseparable on the wire so no caller can perform only one of them.
 *
 * ADMIN-ONLY. A per-object owner-or-admin rule was the obvious alternative and is worse here: a
 * transfer names a SET, so a partial-permission caller would need either a partial application
 * (which defeats the transaction) or a refusal that lists what they may not touch. Giving away
 * ownership is also not an operation whose blast radius suits the weaker check — it is how an
 * object leaves your control entirely. `requireAdmin` is the single enforcement point; this route
 * sits under the CLI-token edge bypass, so a non-admin token gets past the edge and 403s here.
 */

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body)
    return NextResponse.json({ error: "Body must be JSON" }, { status: 422 });

  const toUserId = body.toUserId;
  if (typeof toUserId !== "string" || !toUserId.startsWith("user_"))
    return NextResponse.json(
      { error: "toUserId must be a Clerk user_… id" },
      { status: 422 },
    );

  const role = body.role === undefined ? "viewer" : body.role;
  if (role !== "viewer" && role !== "admin")
    return NextResponse.json(
      { error: 'role must be "viewer" or "admin"' },
      { status: 422 },
    );

  const deviceIds = parseIdList(body.devices);
  const areaIds = parseIdList(body.areas);
  const dashboardIds = parseIdList(body.dashboards);
  const shareBack = parseShareBack(body.shareBackTo, role);
  if (!deviceIds || !areaIds || !dashboardIds || !shareBack)
    return NextResponse.json(
      {
        error:
          "devices/areas/dashboards must be arrays of ids; shareBackTo an array of user_… ids or {userId, role}",
      },
      { status: 422 },
    );

  // 🛑 A dry run must not reach `transferOwnership` — that function's contract is that it writes.
  // Previewing is the CALLER's job: `liveone owner transfer` resolves the whole set itself and
  // prints the exact body it would post, which is a stronger guarantee than a server-side `dryRun`
  // branch (the printed plan IS the request, not a second rendering of it). A `dryRun` flag
  // threaded into a writer is also how a "dry" run comes to write — a defect this codebase has
  // already paid for once.
  if (body.dryRun === true)
    return NextResponse.json(
      {
        error:
          "dryRun is not supported here — this route writes. Preview with the CLI, which computes the plan before calling.",
      },
      { status: 422 },
    );

  try {
    const result = await transferOwnership({
      toUserId,
      deviceIds,
      areaIds,
      dashboardIds,
      shareBack,
      force: body.force === true,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof TransferError)
      return NextResponse.json(
        { error: err.message, ...(err.detail ? { detail: err.detail } : {}) },
        { status: 422 },
      );
    throw err;
  }
}
