import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";

export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof NextResponse) return authResult;

    // Derive from the in-memory devices registry (Postgres-backed) — only ~9 rows.
    const allDevices = await DeviceConfigRegistry.allDevices();
    const deviceNames = [
      ...new Set(allDevices.map((s) => s.displayName)),
    ].sort();
    const vendorTypes = [
      ...new Set(allDevices.map((s) => s.vendorType)),
    ].sort();
    // Hardcoded - these are finite values defined in code
    const causes = ["ADMIN", "CRON", "POLL", "PUSH", "USER", "USER-TEST"];
    // Hardcoded - only 3 possible states: null=pending, true=success, false=failed
    const statuses: (boolean | null)[] = [null, true, false];

    return NextResponse.json({
      success: true,
      filterOptions: {
        deviceName: deviceNames,
        vendorType: vendorTypes,
        cause: causes,
        successful: statuses,
      },
    });
  } catch (error) {
    console.error("[API] Error fetching filter options:", error);
    return NextResponse.json(
      { error: "Failed to fetch filter options" },
      { status: 500 },
    );
  }
}
