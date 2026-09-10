import { NextRequest } from "next/server";
import { handleCreate, handleList } from "@/lib/derivations/v4-routes";

/**
 * Derivations — config that computes a new signal from existing points (clean-sheet §4.4).
 *
 *   GET  ?device=dv_… &area=ar_… &kind= &role= &enabled=  → 200 { derivations: [...] }
 *   POST { kind, … }                                      → 201 { derivation, status }
 *
 * 🛑 **Addressed by identity, not by scope.** The area-scoped tree
 * (`/api/v4/areas/{ar_}/derivations`) still serves the same resource and now delegates here; it is a
 * shim until the CLI moves (PR 4). A derivation's site is DERIVED from its source points
 * (`derivation_sources` → `points.device_id`), so there is no area for a caller to name and none is
 * accepted: authorization is against the derivation's own device set. See
 * `lib/derivations/scope.ts`.
 *
 * ## Deliberately NOT a declarative full-replace collection
 *
 * 🛑 `bindings` is a `PUT` that replaces the whole list, and copying that here would be dangerous:
 * `derived_intervals.derivation_id` is `ON DELETE CASCADE` (migration 0040), so a replace that
 * merely *omitted* a derivation would silently destroy every interval it had ever produced — a year
 * of run periods, with a 200 and no warning. Bindings are cheap to rebuild; a derivation's output is
 * not. So: create is `POST`, edit is `PATCH` on the member, and `DELETE` is on the member behind two
 * interlocks.
 *
 * 400 bad filter id · 401 unauthenticated · 403 no write access to a named device · 422 bad body or
 * a refused create.
 */
export async function GET(request: NextRequest) {
  return handleList(request);
}

export async function POST(request: NextRequest) {
  return handleCreate(request);
}
