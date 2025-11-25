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
    // Join with systems table to get vendorType and displayName (removed from sessions in migration 0054)
    const systemNamesResult = await rawClient.execute(
      `SELECT DISTINCT sys.display_name as system_name
       FROM sessions sess
       INNER JOIN systems sys ON sess.system_id = sys.id
       ORDER BY sys.display_name`,
    );
    const vendorTypesResult = await rawClient.execute(
      `SELECT DISTINCT sys.vendor_type
       FROM sessions sess
       INNER JOIN systems sys ON sess.system_id = sys.id
       ORDER BY sys.vendor_type`,
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
    // SQLite stores booleans as 0/1/NULL, convert properly
    // NULL = pending, 1 = success (true), 0 = failed (false)
    const statuses = statusesResult.rows.map((r: any) => {
      if (r.successful === null) return null;
      return Boolean(r.successful);
    });

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
