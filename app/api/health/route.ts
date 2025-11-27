import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { systems, userSystems } from "@/lib/db/schema";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

interface HealthCheck {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  checks: {
    database: CheckResult;
    tables: CheckResult;
    authentication: CheckResult;
    environment: CheckResult;
  };
  details: {
    tableCount: number;
    missingTables: string[];
    systemCount: number;
    userSystemCount: number;
    environment: string;
    nodeVersion: string;
  };
}

interface CheckResult {
  status: "pass" | "fail";
  message: string;
  duration?: number;
}

const REQUIRED_TABLES = [
  "systems",
  "user_systems",
  "polling_status",
  "point_info",
  "point_readings",
  "point_readings_agg_5m",
  "point_readings_agg_1d",
];

const REQUIRED_ENV_VARS = [
  "TURSO_DATABASE_URL",
  "TURSO_AUTH_TOKEN",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
];

export async function GET() {
  const health: HealthCheck = {
    status: "healthy",
    timestamp: new Date().toISOString(),
    checks: {
      database: { status: "pass", message: "Connected" },
      tables: { status: "pass", message: "All required tables exist" },
      authentication: { status: "pass", message: "Clerk configured" },
      environment: { status: "pass", message: "All required variables set" },
    },
    details: {
      tableCount: 0,
      missingTables: [],
      systemCount: 0,
      userSystemCount: 0,
      environment: process.env.NODE_ENV || "unknown",
      nodeVersion: process.version,
    },
  };

  try {
    // 1. Check database connectivity
    const dbStart = Date.now();
    try {
      // Simple query using Drizzle to test connection
      await db.select().from(systems).limit(1);
      health.checks.database.duration = Date.now() - dbStart;
    } catch (error) {
      health.checks.database = {
        status: "fail",
        message: `Database connection failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        duration: Date.now() - dbStart,
      };
      health.status = "unhealthy";
    }

    // 2. Check required tables exist
    const tableStart = Date.now();
    try {
      // For table checking, we need to use raw SQL since sqlite_master is a system table
      // But we'll use Drizzle for everything else
      const tablesQuery = sql<{ name: string }>`
        SELECT name 
        FROM sqlite_master 
        WHERE type='table' 
          AND name NOT LIKE 'sqlite_%' 
        ORDER BY name
      `;

      // @ts-ignore - Raw SQL query for system table
      const tables = await db.all(tablesQuery);
      const existingTables = tables.map((row: any) => row.name);
      health.details.tableCount = existingTables.length;

      const missingTables = REQUIRED_TABLES.filter(
        (table) => !existingTables.includes(table),
      );
      health.details.missingTables = missingTables;

      if (missingTables.length > 0) {
        health.checks.tables = {
          status: "fail",
          message: `Missing tables: ${missingTables.join(", ")}`,
          duration: Date.now() - tableStart,
        };
        health.status = "unhealthy";
      } else {
        health.checks.tables.duration = Date.now() - tableStart;
      }

      // Count systems and user_systems using Drizzle properly
      if (existingTables.includes("systems")) {
        const systemRows = await db.select().from(systems);
        health.details.systemCount = systemRows.length;
      }

      if (existingTables.includes("user_systems")) {
        const userSystemRows = await db.select().from(userSystems);
        health.details.userSystemCount = userSystemRows.length;
      }
    } catch (error) {
      health.checks.tables = {
        status: "fail",
        message: `Table check failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        duration: Date.now() - tableStart,
      };
      health.status = "degraded";
    }

    // 3. Check authentication configuration
    const authStart = Date.now();
    const clerkPublishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    const clerkSecretKey = process.env.CLERK_SECRET_KEY;

    if (!clerkPublishableKey || !clerkSecretKey) {
      health.checks.authentication = {
        status: "fail",
        message: "Clerk keys not configured",
        duration: Date.now() - authStart,
      };
      health.status = "degraded";
    } else {
      health.checks.authentication.duration = Date.now() - authStart;
    }

    // 4. Check environment variables
    const envStart = Date.now();
    const missingEnvVars = REQUIRED_ENV_VARS.filter(
      (varName) => !process.env[varName],
    );

    if (missingEnvVars.length > 0) {
      health.checks.environment = {
        status: "fail",
        message: `Missing environment variables: ${missingEnvVars.join(", ")}`,
        duration: Date.now() - envStart,
      };
      health.status = "degraded";
    } else {
      health.checks.environment.duration = Date.now() - envStart;
    }

    // Return appropriate status code based on health
    const statusCode =
      health.status === "healthy"
        ? 200
        : health.status === "degraded"
          ? 503
          : 500;

    return NextResponse.json(health, { status: statusCode });
  } catch (error) {
    // Catastrophic failure
    return NextResponse.json(
      {
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Unknown error",
        checks: {
          database: { status: "fail", message: "Unable to perform checks" },
          tables: { status: "fail", message: "Unable to perform checks" },
          authentication: {
            status: "fail",
            message: "Unable to perform checks",
          },
          environment: { status: "fail", message: "Unable to perform checks" },
        },
        details: {
          tableCount: 0,
          missingTables: [],
          systemCount: 0,
          userSystemCount: 0,
          environment: process.env.NODE_ENV || "unknown",
          nodeVersion: process.version,
        },
      },
      { status: 500 },
    );
  }
}
