import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isUserAdmin } from "@/lib/auth-utils";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import { sql } from "drizzle-orm";

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

    // Get all distinct values for each filterable column
    const [systemNames, vendorTypes, causes, statuses] = await Promise.all([
      db
        .selectDistinct({ value: sessions.systemName })
        .from(sessions)
        .orderBy(sessions.systemName),
      db
        .selectDistinct({ value: sessions.vendorType })
        .from(sessions)
        .orderBy(sessions.vendorType),
      db
        .selectDistinct({ value: sessions.cause })
        .from(sessions)
        .orderBy(sessions.cause),
      db
        .selectDistinct({ value: sessions.successful })
        .from(sessions)
        .orderBy(sessions.successful),
    ]);

    return NextResponse.json({
      success: true,
      filterOptions: {
        systemName: systemNames.map((row) => row.value),
        vendorType: vendorTypes.map((row) => row.value),
        cause: causes.map((row) => row.value),
        successful: statuses.map((row) => row.value),
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
