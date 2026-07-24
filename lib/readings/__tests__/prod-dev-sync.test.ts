import { describe, expect, it } from "@jest/globals";
import { Readable, Writable } from "node:stream";
import type { Client } from "pg";
import {
  prodDevSyncManifest,
  syncProdToDev,
  syncTable,
} from "../prod-dev-sync";

function copyClients(options: { failUpsert?: boolean } = {}) {
  const devSql: string[] = [];
  const source = Readable.from(["1\t2026-01-01\n"]);
  const destination = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  }) as Writable & { rowCount: number };
  destination.rowCount = 1;

  const prod = {
    query(command: unknown) {
      expect(typeof command).not.toBe("string");
      return source;
    },
  } as unknown as Client;
  const dev = {
    query(command: unknown) {
      if (typeof command !== "string") return destination;
      devSql.push(command);
      if (command.startsWith("SELECT (max("))
        return Promise.resolve({ rows: [{ wm: null }] });
      if (
        options.failUpsert &&
        command.startsWith("INSERT INTO public.point_readings")
      ) {
        return Promise.reject(new Error("upsert failed"));
      }
      return Promise.resolve({ rows: [] });
    },
  } as unknown as Client;
  return { prod, dev, devSql };
}

describe("prod→dev readings transfer", () => {
  it("pins table order and the three hot-table sync policies", () => {
    const manifest = prodDevSyncManifest();
    expect(manifest.map((table) => table.name)).toEqual([
      "systems",
      "users",
      "user_systems",
      "polling_status",
      "share_tokens",
      "roles",
      "areas",
      "point_info",
      "area_devices",
      "area_bindings",
      "device_trackers",
      "dashboards",
      "sessions",
      "point_readings",
      "point_readings_agg_5m",
      "point_readings_agg_1d",
      "point_readings_flow_attr_1d",
      "battery_provenance_daily",
    ]);
    expect(
      manifest
        .filter((table) => table.name.startsWith("point_readings"))
        .slice(0, 3),
    ).toMatchObject([
      {
        name: "point_readings",
        mode: "incremental",
        watermark: "created_at",
        overlap: "2 hours",
        onConflict: "nothing",
        conflictCols: ["system_id", "point_id", "measurement_time"],
        excludeCols: ["id"],
      },
      {
        name: "point_readings_agg_5m",
        mode: "incremental",
        watermark: "updated_at",
        overlap: "2 hours",
        onConflict: "update",
      },
      {
        name: "point_readings_agg_1d",
        mode: "incremental",
        watermark: "updated_at",
        overlap: "2 days",
        onConflict: "update",
      },
    ]);
  });

  it("fails closed before connecting when the write target is prod", async () => {
    await expect(
      syncProdToDev({
        prodUrl: "postgres://postgres.same:ro@db.example/prod",
        devUrl: "postgres://postgres.same:rw@db.example/prod",
      }),
    ).rejects.toThrow("same branch/role");
    await expect(
      syncProdToDev({
        prodUrl: "postgres://postgres.prod:ro@db.example/prod",
        devUrl: "postgres://postgres.dev:rw@db.example/prod-token",
        prodBranchId: "prod-token",
      }),
    ).rejects.toThrow("production identifier");
  });

  it("streams an incremental hot table and preserves its upsert policy", async () => {
    const table = prodDevSyncManifest().find(
      (entry) => entry.name === "point_readings",
    )!;
    const { prod, dev, devSql } = copyClients();
    await expect(
      syncTable(
        prod,
        dev,
        table,
        new Map([
          [
            "point_readings",
            ["id", "system_id", "point_id", "measurement_time", "value"],
          ],
        ]),
        new Map([["point_readings", ["id"]]]),
      ),
    ).resolves.toEqual({ table: "point_readings", rows: 1 });

    expect(devSql[1]).toContain("CREATE UNLOGGED TABLE");
    expect(devSql.at(-1)).toContain(
      "ON CONFLICT (system_id, point_id, measurement_time) DO NOTHING",
    );
  });

  it("rolls back a failed upsert and keeps hot child deletes in point-info drift handling", async () => {
    const raw = prodDevSyncManifest().find(
      (entry) => entry.name === "point_readings",
    )!;
    const failed = copyClients({ failUpsert: true });
    await expect(
      syncTable(
        failed.prod,
        failed.dev,
        raw,
        new Map([
          [
            "point_readings",
            ["id", "system_id", "point_id", "measurement_time", "value"],
          ],
        ]),
        new Map([["point_readings", ["id"]]]),
      ),
    ).rejects.toThrow("upsert failed");
    expect(failed.devSql.at(-1)).toBe("ROLLBACK");

    const pointInfo = prodDevSyncManifest().find(
      (entry) => entry.name === "point_info",
    )!;
    const drift = copyClients();
    await syncTable(
      drift.prod,
      drift.dev,
      pointInfo,
      new Map([
        [
          "point_info",
          [
            "system_id",
            "id",
            "physical_path_tail",
            "logical_path_stem",
            "metric_type",
            "point_uid",
            "rid",
          ],
        ],
      ]),
      new Map([["point_info", ["system_id", "id"]]]),
    );
    const driftSql = drift.devSql.at(-1)!;
    expect(driftSql).toContain("ANALYZE _drift");
    expect(driftSql).toContain("DELETE FROM public.point_readings ");
    expect(driftSql).toContain("DELETE FROM public.point_readings_agg_5m ");
    expect(driftSql).toContain("DELETE FROM public.point_readings_agg_1d ");
  });
});
