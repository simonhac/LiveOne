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

    // Get all sessions and extract unique values
    const allSessions = await db.select().from(sessions);

    // Extract unique values for each filterable column
    const systemNames = [
      ...new Set(allSessions.map((s) => s.systemName)),
    ].sort();
    const vendorTypes = [
      ...new Set(allSessions.map((s) => s.vendorType)),
    ].sort();
    const causes = [...new Set(allSessions.map((s) => s.cause))].sort();
    const statuses = [...new Set(allSessions.map((s) => s.successful))].sort();

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
