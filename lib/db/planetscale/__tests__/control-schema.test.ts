import { describe, it, expect } from "@jest/globals";
import { getTableConfig } from "drizzle-orm/pg-core";
import { automations, pointCommands, points } from "../schema";

/**
 * Wire-level pin for the control-plane tables (migration 0058).
 *
 * Pure drizzle introspection — no DB connection, no `planetscaleDb` import. The point is that a
 * future rename of a table, column, CHECK or index bricks THIS test before it bricks someone's raw
 * SQL, a migration, or a cross-environment query. It deliberately pins names and nullability only,
 * not drizzle internals.
 */

/** TS property name -> SQL column name, which is what raw-SQL callers actually depend on. */
function columnMap(
  table: Parameters<typeof getTableConfig>[0],
): Record<string, string> {
  const out: Record<string, string> = {};
  const columnNames = new Set(getTableConfig(table).columns.map((c) => c.name));
  for (const [key, value] of Object.entries(
    table as unknown as Record<string, unknown>,
  )) {
    if (typeof value !== "object" || value === null) continue;
    const name = (value as { name?: unknown }).name;
    if (typeof name === "string" && columnNames.has(name)) out[key] = name;
  }
  return out;
}

function sqlNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table)
    .columns.map((c) => c.name)
    .sort();
}

function nullableNames(table: Parameters<typeof getTableConfig>[0]): string[] {
  return getTableConfig(table)
    .columns.filter((c) => !c.notNull)
    .map((c) => c.name)
    .sort();
}

const cases = [
  {
    label: "point_commands",
    table: pointCommands,
    sqlName: "point_commands",
    columns: [
      "id",
      "point_id",
      "device_id",
      "action",
      "value",
      "requested_by",
      "status",
      "vendor_result",
      "error",
      "requested_at",
      "completed_at",
    ],
    nullable: ["value", "vendor_result", "error", "completed_at"],
    checks: ["point_commands_status_check"],
    indexes: [
      "point_commands_device_requested_idx",
      "point_commands_point_idx",
    ],
  },
  {
    label: "automations",
    table: automations,
    sqlName: "automations",
    columns: [
      "id",
      "area_id",
      "name",
      "enabled",
      "mode",
      "trigger",
      "action",
      "armed_at",
      "last_triggered_at",
      "last_triggered_run_start",
      "armed_context",
      "created_at",
      "updated_at",
    ],
    nullable: [
      "armed_at",
      "last_triggered_at",
      "last_triggered_run_start",
      "armed_context",
    ],
    checks: ["automations_mode_check"],
    indexes: ["automations_area_idx"],
  },
] as const;

describe("control-plane tables (migration 0058)", () => {
  for (const c of cases) {
    describe(c.label, () => {
      it("has the expected SQL table name", () => {
        expect(getTableConfig(c.table).name).toBe(c.sqlName);
      });

      it("has exactly the expected SQL column names", () => {
        expect(sqlNames(c.table)).toEqual([...c.columns].sort());
      });

      it("has exactly the expected nullable columns", () => {
        expect(nullableNames(c.table)).toEqual([...c.nullable].sort());
      });

      it("declares the expected CHECK constraints", () => {
        expect(
          getTableConfig(c.table)
            .checks.map((k) => k.name)
            .sort(),
        ).toEqual([...c.checks].sort());
      });

      it("declares the expected indexes", () => {
        expect(
          getTableConfig(c.table)
            .indexes.map((i) => i.config.name)
            .sort(),
        ).toEqual([...c.indexes].sort());
      });
    });
  }
});

describe("points.control", () => {
  it("exists, is named `control`, and is nullable", () => {
    const control = getTableConfig(points).columns.find(
      (col) => col.name === "control",
    );
    expect(control).toBeDefined();
    expect(control?.notNull).toBe(false);
    // Nullable with no default: NULL means read-only sensor, which is what every pre-0058 row is.
    expect(control?.hasDefault).toBe(false);
  });
});

describe("TS property -> SQL column mapping", () => {
  it("pins point_commands", () => {
    expect(columnMap(pointCommands)).toEqual({
      id: "id",
      pointId: "point_id",
      deviceId: "device_id",
      action: "action",
      value: "value",
      requestedBy: "requested_by",
      status: "status",
      vendorResult: "vendor_result",
      error: "error",
      requestedAt: "requested_at",
      completedAt: "completed_at",
    });
  });

  it("pins automations", () => {
    expect(columnMap(automations)).toEqual({
      id: "id",
      areaId: "area_id",
      name: "name",
      enabled: "enabled",
      mode: "mode",
      trigger: "trigger",
      action: "action",
      armedAt: "armed_at",
      lastTriggeredAt: "last_triggered_at",
      lastTriggeredRunStart: "last_triggered_run_start",
      armedContext: "armed_context",
      createdAt: "created_at",
      updatedAt: "updated_at",
    });
  });
});
