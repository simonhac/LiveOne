import { NextRequest, NextResponse } from "next/server";
import { validateDocV4 } from "@/lib/dashboard/v4-validate";
import { loadOwnedDashboard } from "@/lib/dashboard/v4-routes";

/**
 * config-v4 dry-run validation (§9.1) — the editor's live lint. Owner/admin only. Never persists;
 * returns doc-shape validity + issues + the normalized canonical doc for preview.
 *
 *   POST { doc } → 200 { valid, errors, warnings, normalized }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const r = await loadOwnedDashboard(request, id);
  if ("error" in r) return r.error;

  const body = await request.json().catch(() => null);
  const result = validateDocV4(body?.doc);
  return NextResponse.json({
    valid: result.valid,
    errors: result.errors,
    warnings: result.warnings,
    normalized: result.normalized ?? null,
  });
}
