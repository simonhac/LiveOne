import { NextRequest } from "next/server";
import {
  handleDelete,
  handleGet,
  handlePatch,
} from "@/lib/derivations/v4-routes";

/**
 * One derivation, by identity.
 *
 *   GET    → 200 { derivation }
 *   PATCH  { enabled?, name?, params?, boundaryPointUid? } → 200 { derivation }
 *   DELETE ?force=true → 200 { deleted, forced }
 *
 * Authorized against the derivation's OWN device set (`lib/derivations/scope.ts`): read on every
 * device to see it, write on every device to change it. 400 bad id · 401 unauthenticated · 404
 * unknown OR unreadable (deliberately indistinguishable) · 403 readable but not writable · 409 a
 * DELETE that is still enabled or still relied upon · 422 bad body.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ dxid: string }> },
) {
  const { dxid } = await params;
  return handleGet(request, dxid);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ dxid: string }> },
) {
  const { dxid } = await params;
  return handlePatch(request, dxid);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ dxid: string }> },
) {
  const { dxid } = await params;
  return handleDelete(request, dxid);
}
