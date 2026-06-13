import { NextRequest, NextResponse } from "next/server";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import { systems } from "@/lib/db/planetscale/schema";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/api-auth";
import { SystemsManager } from "@/lib/systems-manager";

// Generic per-system metadata config endpoint.
//
// Reads/writes a namespaced section of the `systems.metadata` JSONB column so any vendor or
// feature can persist its own config blob without a bespoke route. It is intentionally NOT
// vendor-specific: callers pass a `key` (the namespace, e.g. "tesla") and a `value` object,
// and we shallow-merge `{ [key]: value }` into the existing metadata, leaving sibling keys
// untouched. Semantic validation of the value is the caller's / consumer's responsibility
// (e.g. the Tesla adapter clamps its own intervals defensively).

// Namespace key must look like an identifier — avoids accidental odd keys in the JSON.
const KEY_PATTERN = /^[a-z][a-zA-Z0-9_]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Read a system's metadata, tolerating the legacy double-encoded (stringified) shape.
function readMetadata(raw: unknown): Record<string, unknown> {
  let metadata = raw ?? {};
  if (typeof metadata === "string") {
    try {
      metadata = JSON.parse(metadata);
    } catch {
      metadata = {};
    }
  }
  return isPlainObject(metadata) ? metadata : {};
}

async function loadSystem(systemId: number) {
  const [system] = await requirePlanetscaleDb()
    .select()
    .from(systems)
    .where(eq(systems.id, systemId))
    .limit(1);
  return system ?? null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof NextResponse) return authResult;

    const { systemId: systemIdStr } = await params;
    const systemId = parseInt(systemIdStr);
    if (isNaN(systemId)) {
      return NextResponse.json({ error: "Invalid system ID" }, { status: 400 });
    }

    const system = await loadSystem(systemId);
    if (!system) {
      return NextResponse.json({ error: "System not found" }, { status: 404 });
    }

    const metadata = readMetadata(system.metadata);
    const key = request.nextUrl.searchParams.get("key");

    // With ?key=, return just that namespace's value; otherwise the whole metadata object.
    if (key) {
      return NextResponse.json({
        success: true,
        key,
        value: (metadata[key] as unknown) ?? null,
      });
    }
    return NextResponse.json({ success: true, metadata });
  } catch (error) {
    console.error("Error fetching system metadata:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch system metadata" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof NextResponse) return authResult;

    const { systemId: systemIdStr } = await params;
    const systemId = parseInt(systemIdStr);
    if (isNaN(systemId)) {
      return NextResponse.json({ error: "Invalid system ID" }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const { key, value } = body ?? {};

    if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
      return NextResponse.json(
        { error: "A valid namespace `key` is required" },
        { status: 400 },
      );
    }
    if (!isPlainObject(value)) {
      return NextResponse.json(
        { error: "`value` must be a JSON object" },
        { status: 400 },
      );
    }

    const system = await loadSystem(systemId);
    if (!system) {
      return NextResponse.json({ error: "System not found" }, { status: 404 });
    }

    // Shallow-merge the namespaced value into existing metadata (preserve sibling keys).
    const existing = readMetadata(system.metadata);
    const metadata = { ...existing, [key]: value };

    await SystemsManager.getInstance().updateSystem(systemId, {
      metadata: metadata as never,
    });

    return NextResponse.json({
      success: true,
      message: "Metadata updated successfully",
      key,
      value,
    });
  } catch (error) {
    console.error("Error updating system metadata:", error);
    return NextResponse.json(
      { success: false, error: "Failed to update system metadata" },
      { status: 500 },
    );
  }
}
