import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isUserAdmin } from "@/lib/auth-utils";
import { rawClient } from "@/lib/db";

export async function GET() {
  try {
    // Check if user is authenticated
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Check if user is an admin
    const isAdmin = await isUserAdmin();
    if (!isAdmin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Get unique values for each filterable column using SQL DISTINCT
    // This is much more efficient than fetching all sessions
    const systemNamesResult = await rawClient.execute(
      "SELECT DISTINCT system_name FROM sessions ORDER BY system_name",
    );
    const vendorTypesResult = await rawClient.execute(
      "SELECT DISTINCT vendor_type FROM sessions ORDER BY vendor_type",
    );
    const causesResult = await rawClient.execute(
      "SELECT DISTINCT cause FROM sessions ORDER BY cause",
    );
    const statusesResult = await rawClient.execute(
      "SELECT DISTINCT successful FROM sessions ORDER BY successful",
    );

    const systemNames = systemNamesResult.rows.map(
      (r: any) => r.system_name as string,
    );
    const vendorTypes = vendorTypesResult.rows.map(
      (r: any) => r.vendor_type as string,
    );
    const causes = causesResult.rows.map((r: any) => r.cause as string);
    const statuses = statusesResult.rows.map(
      (r: any) => r.successful as boolean,
    );

    return NextResponse.json({
      success: true,
      filterOptions: {
        systemName: systemNames,
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
