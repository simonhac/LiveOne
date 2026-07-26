import { describe, expect, it } from "@jest/globals";
import { Readable, Writable } from "node:stream";
import type { Client } from "pg";
import {
  assertManifestSchemaParity,
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
  it("fails clearly when prod and dev manifest schemas differ", async () => {
    const client = (rows: Array<{ table_name: string; signature: string }>) =>
      ({
        query: () => Promise.resolve({ rows }),
      }) as unknown as Client;

    await expect(
      assertManifestSchemaParity(
        client([
          {
            table_name: "area_bindings",
            signature: 'index:["area_bindings_unique","prod definition"]',
          },
        ]),
        client([
          {
            table_name: "area_bindings",
            signature: 'index:["area_bindings_unique","dev definition"]',
          },
        ]),
        ["area_bindings"],
      ),
    ).rejects.toThrow(
      "prod/dev schema mismatch for sync manifest (prod-only: area_bindings:index",
    );
  });

  it("accepts identical manifest schemas regardless of client timing", async () => {
    const rows = [
      {
        table_name: "point_readings",
        signature: 'column:[1,"system_id"]',
      },
    ];
    const client = {
      query: () => Promise.resolve({ rows }),
    } as unknown as Client;
    await expect(
      assertManifestSchemaParity(client, client, ["point_readings"]),
    ).resolves.toBeUndefined();
  });

  it("pins table order and the three hot-table sync policies", () => {
    const manifest = prodDevSyncManifest();
    const names = manifest.map((table) => table.name);
    expect(names).toEqual([
      "systems",
      "dashboards",
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
      "sessions",
      "point_readings",
      "point_readings_agg_5m",
      "point_readings_agg_1d",
      "point_readings_flow_attr_1d",
      "battery_provenance_daily",
    ]);
    // dashboards' uuid PK is minted independently per environment (only legacy_id is stable), so it
    // must sync BEFORE any table with an FK to dashboards.id — otherwise users.default_dashboard_id /
    // share_tokens.dashboard_id copy a prod uuid that doesn't yet exist in dev.
    expect(names.indexOf("dashboards")).toBeLessThan(names.indexOf("users"));
    expect(names.indexOf("dashboards")).toBeLessThan(
      names.indexOf("share_tokens"),
    );
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
        conflictCols: ["point_rid", "measurement_time"],
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

  it("syncs dashboards via a legacy_id-keyed idDrift, not the retired serial mirror", async () => {
    const table = prodDevSyncManifest().find(
      (entry) => entry.name === "dashboards",
    )!;
    expect(table).toMatchObject({
      mode: "full",
      onConflict: "update",
      idDrift: {
        uniqueKeys: [["legacy_id"], ["owner_user_id", "slug"]],
        children: [],
      },
    });
    expect(table).not.toHaveProperty("mirror");

    const { prod, dev, devSql } = copyClients();
    await syncTable(
      prod,
      dev,
      table,
      new Map([
        [
          "dashboards",
          [
            "id",
            "legacy_id",
            "owner_user_id",
            "name",
            "slug",
            "descriptor",
            "doc",
            "revision",
            "created_at",
            "updated_at",
          ],
        ],
      ]),
      new Map([["dashboards", ["id"]]]),
    );

    const sql = devSql.at(-1)!;
    expect(sql).toContain("CREATE TEMP TABLE _drift");
    expect(sql).toContain("ANALYZE _drift");
    expect(sql).toContain("d.legacy_id = s.legacy_id");
    expect(sql).toContain(
      "d.owner_user_id = s.owner_user_id AND d.slug = s.slug",
    );
    expect(sql).toContain("DELETE FROM public.dashboards d USING _drift");
    expect(sql).toContain("ON CONFLICT (id) DO UPDATE");
    expect(sql).toContain("COMMIT;");
    // Regression guards: the retired serial-PK mirror mode must not resurface, and dashboards' own
    // idDrift must never delete its FK children directly (they're all CASCADE/SET NULL already).
    expect(sql).not.toContain("setval");
    expect(sql).not.toContain("pg_get_serial_sequence");
    expect(sql).not.toContain("DELETE FROM public.users");
    expect(sql).not.toContain("DELETE FROM public.share_tokens");
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
            ["point_rid", "session_id", "measurement_time", "value"],
          ],
        ]),
        new Map([["point_readings", ["point_rid", "measurement_time"]]]),
      ),
    ).resolves.toEqual({ table: "point_readings", rows: 1 });

    expect(devSql[1]).toContain("CREATE UNLOGGED TABLE");
    expect(devSql.at(-1)).toContain(
      "ON CONFLICT (point_rid, measurement_time) DO NOTHING",
    );
  });

  it("reconciles area-binding slot collisions atomically before upsert", async () => {
    const table = prodDevSyncManifest().find(
      (entry) => entry.name === "area_bindings",
    )!;
    expect(table).toMatchObject({
      conflictCols: [
        "area_id",
        "role",
        "metric_type",
        "point_system_id",
        "point_id",
      ],
      replaceConflicts: [["area_id", "role", "metric_type", "priority"]],
    });

    const { prod, dev, devSql } = copyClients();
    await syncTable(
      prod,
      dev,
      table,
      new Map([
        [
          "area_bindings",
          [
            "id",
            "area_id",
            "role",
            "metric_type",
            "point_system_id",
            "point_id",
            "priority",
          ],
        ],
      ]),
      new Map([["area_bindings", ["id"]]]),
    );

    const reconciliation = devSql.at(-1)!;
    expect(reconciliation).toContain("BEGIN;");
    expect(reconciliation).toContain("DELETE FROM public.area_bindings d");
    expect(reconciliation).toContain(
      "d.area_id = s.area_id AND d.role = s.role AND d.metric_type = s.metric_type AND d.priority = s.priority",
    );
    expect(reconciliation).toContain(
      "ON CONFLICT (area_id, role, metric_type, point_system_id, point_id) DO UPDATE",
    );
    expect(reconciliation).toContain("COMMIT;");
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
