import { NextRequest } from "next/server";
import { loadAreaForOwner } from "@/lib/areas/http";
import {
  handleDelete,
  handleGet,
  handlePatch,
} from "@/lib/derivations/v4-routes";

/**
 * SHIM onto `/api/v4/derivations/{dx_}` — see the note in the collection route.
 *
 * 🛑 The area is no longer in the UPDATE's WHERE clause, and nothing replaces it: the derivation is
 * authorized against its own device set. That is what makes the cross-area PATCH this route used to
 * refuse with a 404 now simply WORK — the area was never a fact about the derivation, and the old
 * check could only ever have been "did you name the area we happened to stamp on it".
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; dxid: string }> },
) {
  const { id, dxid } = await params;
  const authed = await loadAreaForOwner(request, id);
  if ("error" in authed) return authed.error;
  return handleGet(request, dxid);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; dxid: string }> },
) {
  const { id, dxid } = await params;
  const authed = await loadAreaForOwner(request, id);
  if ("error" in authed) return authed.error;
  return handlePatch(request, dxid);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; dxid: string }> },
) {
  const { id, dxid } = await params;
  const authed = await loadAreaForOwner(request, id);
  if ("error" in authed) return authed.error;
  return handleDelete(request, dxid);
}
