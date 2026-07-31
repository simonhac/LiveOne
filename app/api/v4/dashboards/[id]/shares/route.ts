import { NextRequest, NextResponse } from "next/server";
import { loadOwnedDashboard } from "@/lib/dashboard/v4-routes";
import {
  createDashboardShareToken,
  getDashboardShareToken,
  listDashboardShareTokens,
  renameDashboardShareToken,
  revokeDashboardShareToken,
} from "@/lib/dashboard/sharing";

/**
 * config-v4 share links for a dashboard (§9.2 `/dashboards/{id}/shares`). Owner/admin only.
 *
 *   GET    → 200 { tokens: [{ token, label, createdAtMs, expiresAtMs, revokedAtMs, lastUsedAtMs }] }
 *   POST   { label?, expiresInDays? } → 201 { token, label, createdAtMs, expiresAtMs, revokedAtMs, lastUsedAtMs }
 *   PATCH  { token, label }           → 200 { ok, …the updated row }   · 404 unknown · 409 revoked
 *   DELETE ?token=…                   → 200 { ok, …the revoked row }   · 404 unknown  (idempotent re-revoke)
 *   any    → 404 unknown dashboard · 403 not yours · 422 malformed body
 *
 * 🛑 THESE ARE OWNER-SIDE MUTATIONS AND MUST STAY CLERK-GATED. A share token authorizes an ANONYMOUS
 * reader, so `middleware.ts` pairs `isShareableRoute` with a GET/HEAD-only check — a token can never
 * reach a write. Nothing here is added to `shareableRoutes` (`lib/route-matchers.ts`), and nothing here
 * may be: a token that could mint or relabel tokens would be a self-extending credential. The routes
 * these tokens DO reach (`/api/data`, `/api/history`, `/api/device/*`) are read-only and validate the
 * token again in-handler via `requireDashboardAccess`.
 *
 * 🛑 The token's SCOPE is not stored. It is derived live, per request, from the dashboard doc's §8.3
 * envelope refs (`allowedSystemIds` ← `lib/dashboard/access.ts`), so a token grants what the doc
 * references NOW — not what it referenced at mint time. Editing the doc re-aims every live token.
 *
 * Relative to the legacy `/api/dashboards/{id}/share` twin the payloads are supersets, and the two
 * "nothing happened" cases became status codes: legacy PATCH/DELETE returned `200 {ok:false}` when the
 * token did not exist, which is indistinguishable from success to a caller that only checks `res.ok` —
 * on a revocation path that is the difference between "revoked" and "still live".
 */

/** A `label`, if supplied, must be a non-blank string — a mislabelled link is a link nobody revokes. */
function parseLabel(raw: unknown): string | { error: string } {
  if (raw === undefined || raw === null) return "Shared link";
  if (typeof raw !== "string") return { error: "label must be a string" };
  const trimmed = raw.trim();
  if (!trimmed) return { error: "label cannot be empty" };
  return trimmed;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await loadOwnedDashboard(request, id);
  if ("error" in r) return r.error;
  const tokens = await listDashboardShareTokens(r.dashboard.id);
  return NextResponse.json({ tokens });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await loadOwnedDashboard(request, id);
  if ("error" in r) return r.error;

  const body = await request.json().catch(() => null);
  const label = parseLabel(body?.label);
  if (typeof label !== "string") {
    return NextResponse.json({ errors: [label.error] }, { status: 422 });
  }
  // ⚠️ NOT the legacy silent coercion. `expiresInDays: "7"` used to fall through to `null` — a link the
  // caller believes expires in a week and which in fact never expires. On a credential, silently
  // widening the grant is the wrong direction to fail in.
  let expiresInDays: number | null = null;
  if (body?.expiresInDays !== undefined && body?.expiresInDays !== null) {
    if (
      typeof body.expiresInDays !== "number" ||
      !Number.isFinite(body.expiresInDays) ||
      body.expiresInDays <= 0
    ) {
      return NextResponse.json(
        { errors: ["expiresInDays must be a positive number of days"] },
        { status: 422 },
      );
    }
    expiresInDays = body.expiresInDays;
  }

  const { token } = await createDashboardShareToken({
    dashboardId: r.dashboard.id,
    label,
    expiresInDays,
  });
  // Read the row back rather than reconstructing it: the response then reports what was PERSISTED
  // (createdAt is set inside the DAO), and a mint that somehow did not land cannot answer 201.
  const share = await getDashboardShareToken(token, r.dashboard.id);
  if (!share) {
    return NextResponse.json(
      { error: "the minted token could not be read back" },
      { status: 500 },
    );
  }
  return NextResponse.json(share, { status: 201 });
}

/** PATCH — relabel one token. The label is cosmetic; it never affects what the token reaches. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await loadOwnedDashboard(request, id);
  if ("error" in r) return r.error;

  const body = await request.json().catch(() => null);
  if (typeof body?.token !== "string" || !body.token.trim()) {
    return NextResponse.json(
      { errors: ["token is required"] },
      { status: 422 },
    );
  }
  const label = parseLabel(body?.label);
  if (typeof label !== "string") {
    return NextResponse.json({ errors: [label.error] }, { status: 422 });
  }
  const token = body.token.trim();

  const renamed = await renameDashboardShareToken(token, r.dashboard.id, label);
  // Scoped to THIS dashboard in the DAO's WHERE, so another owner's token reads as absent here.
  const share = await getDashboardShareToken(token, r.dashboard.id);
  if (!share) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!renamed) {
    // Exists but the UPDATE matched nothing → it is revoked (the DAO's only other predicate).
    return NextResponse.json(
      { error: "that link is revoked", ...share },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true, ...share });
}

/** DELETE — revoke one token. Idempotent: re-revoking an already-revoked token is a 200, not an error. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await loadOwnedDashboard(request, id);
  if ("error" in r) return r.error;

  const token = new URL(request.url).searchParams.get("token");
  if (!token) {
    return NextResponse.json(
      { errors: ["token is required"] },
      { status: 422 },
    );
  }
  await revokeDashboardShareToken(token, r.dashboard.id);
  // Read back UNCONDITIONALLY, and report the row. An under-delete (the token still live) and an
  // over-delete are indistinguishable from a bare `{ok:true}`; `revokedAtMs` in the response is the
  // caller's proof, and it is read from the database rather than asserted by the handler.
  const share = await getDashboardShareToken(token, r.dashboard.id);
  if (!share) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, ...share });
}
