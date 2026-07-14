import { NextRequest, NextResponse } from "next/server";
import { requireSystemAccess } from "@/lib/api-auth";
import {
  storeSystemCredentials,
  type VendorType,
} from "@/lib/secure-credentials";
import { VendorRegistry } from "@/lib/vendors/registry";

/**
 * Owner/admin editor for an existing system's vendor credentials (e.g. rotating an Amber API key).
 *
 * Credentials live in the OWNER's Clerk private metadata — the same store the minutely poll reads
 * (lib/secure-credentials.ts) — so an admin editing someone else's system writes under the owner,
 * not themselves. The vendor type is taken from the system, never the client. OAuth vendors (Tesla)
 * and push/app-key vendors (fusher/fronius/openelectricity) have no editable credential fields and
 * are rejected — Tesla re-auth is its own OAuth flow.
 *
 * PUT body: { credentials: Record<string, string> }
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  const { systemId: s } = await params;
  const systemId = parseInt(s, 10);
  if (isNaN(systemId)) {
    return NextResponse.json({ error: "Invalid system id" }, { status: 400 });
  }

  // Editing credentials is an owner action → require write access.
  const auth = await requireSystemAccess(request, systemId, {
    requireWrite: true,
  });
  if (auth instanceof NextResponse) return auth;

  const { ownerClerkUserId, vendorType } = auth.system;
  if (!ownerClerkUserId) {
    return NextResponse.json(
      { error: "Ownerless systems have no per-user credentials to update" },
      { status: 400 },
    );
  }

  const adapter = VendorRegistry.getAdapter(vendorType);
  if (!adapter) {
    return NextResponse.json(
      { error: `Unknown vendor type: ${vendorType}` },
      { status: 400 },
    );
  }

  const fields = adapter.credentialFields ?? [];
  if (adapter.addSystemFlow === "oauth-redirect" || fields.length === 0) {
    return NextResponse.json(
      { error: `${adapter.displayName} credentials cannot be edited here` },
      { status: 400 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    credentials?: Record<string, unknown>;
  };
  const rawCredentials = body.credentials;
  if (!rawCredentials || typeof rawCredentials !== "object") {
    return NextResponse.json(
      { error: "credentials object is required" },
      { status: 400 },
    );
  }

  // Keep only known credential fields, coerce to strings, and confirm the required
  // ones are non-empty. No fallbacks — a missing required field is an error.
  const credentials: Record<string, string> = {};
  for (const field of fields) {
    const value = rawCredentials[field.name];
    const str = typeof value === "string" ? value.trim() : "";
    if (str) {
      credentials[field.name] = str;
    } else if (field.required) {
      return NextResponse.json(
        { error: `Missing required field: ${field.label}` },
        { status: 400 },
      );
    }
  }

  const result = await storeSystemCredentials(
    ownerClerkUserId,
    systemId,
    // The adapter was resolved from this vendorType above, so it's a known vendor;
    // the system record types it only as `string`.
    vendorType as VendorType,
    credentials,
  );
  if (!result.success) {
    return NextResponse.json(
      { error: result.error || "Failed to update credentials" },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true });
}
