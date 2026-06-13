import { NextRequest, NextResponse } from "next/server";
import { requireSystemAccess } from "@/lib/api-auth";
import { getLatestPointValues } from "@/lib/kv-cache-manager";
import { jsonResponse } from "@/lib/json";

/**
 * GET /api/grid/{systemId}
 *
 * Live "now" grid signals for an OpenElectricity NEM-region system: spot price,
 * emissions intensity, and renewables share. These OE region systems are PUBLIC, so a
 * household dashboard can cross-system fetch its local region's signals.
 *
 * Reads the three exact KV latest-value keys:
 *   - "grid.price/rate"                  (stored $/MWh)
 *   - "grid.emissionsIntensity/intensity" (stored tCO2e/MWh)
 *   - "grid.renewables/proportion"       (stored %)
 * Display-unit conversion happens client-side.
 *
 * @param systemId - Numeric OpenElectricity region system ID
 *
 * Example response:
 * {
 *   "systemId": 42,
 *   "region": "NSW1",
 *   "price": { "value": 85.3, "measurementTime": "2026-06-13T14:30:00+10:00" },
 *   "emissionsIntensity": { "value": 0.62, "measurementTime": "2026-06-13T14:30:00+10:00" },
 *   "renewables": { "value": 38, "measurementTime": "2026-06-13T14:30:00+10:00" }
 * }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ systemId: string }> },
) {
  try {
    // Parse and validate systemId
    const { systemId: systemIdStr } = await params;
    const systemId = parseInt(systemIdStr, 10);

    if (isNaN(systemId)) {
      return NextResponse.json(
        { error: "Invalid system ID", details: "System ID must be numeric" },
        { status: 400 },
      );
    }

    // Authenticate and authorize (grants read on public systems)
    const authResult = await requireSystemAccess(request, systemId);
    if (authResult instanceof NextResponse) return authResult;
    const { system } = authResult;

    // Only OpenElectricity region systems carry grid signals
    if (system.vendorType !== "openelectricity") {
      return NextResponse.json(
        { error: "System is not a grid-region system" },
        { status: 404 },
      );
    }

    const timezoneOffsetMin = system.timezoneOffsetMin ?? 600; // Default to AEST

    // Read latest values from KV and pluck the three grid metrics
    const latest = await getLatestPointValues(systemId);

    const metric = (logicalPath: string) => {
      const cached = latest[logicalPath];
      if (!cached || typeof cached.value !== "number") return null;
      // jsonResponse renames measurementTimeMs -> measurementTime (ISO string).
      return {
        value: cached.value,
        measurementTimeMs: cached.measurementTimeMs,
      };
    };

    return jsonResponse(
      {
        systemId,
        region: system.vendorSiteId,
        price: metric("grid.price/rate"),
        emissionsIntensity: metric("grid.emissionsIntensity/intensity"),
        renewables: metric("grid.renewables/proportion"),
      },
      timezoneOffsetMin,
    );
  } catch (error) {
    console.error("Error fetching grid signals:", error);
    return NextResponse.json(
      {
        error: "Internal server error",
        details:
          error instanceof Error ? error.message : "Unknown error occurred",
      },
      { status: 500 },
    );
  }
}
