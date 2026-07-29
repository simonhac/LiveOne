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
      "polling_status",
      "share_tokens",
      "areas",
      "devices",
      "points",
      "area_members",
      "device_state",
      "legacy_handles",
      "point_info",
      "area_bindings",
      "derivations",
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
    // derivations.area_id is a NOT NULL FK, so areas must land first.
    expect(names.indexOf("areas")).toBeLessThan(names.indexOf("derivations"));
    // config-v4 v4 registries. devices.primary_area_id is a NOT NULL FK to areas; points, area_members,
    // device_state and legacy_handles all FK devices.id (points.device_id NOT NULL). So the group is
    // strictly ordered areas → devices → the rest.
    expect(names.indexOf("areas")).toBeLessThan(names.indexOf("devices"));
    for (const child of [
      "points",
      "area_members",
      "device_state",
      "legacy_handles",
    ]) {
      expect(names.indexOf("devices")).toBeLessThan(names.indexOf(child));
    }
    // The whole point of the group: point_readings and both agg twins FK point_rid → points.rid, so a
    // point minted on prod must reach dev's `points` BEFORE the incremental readings legs try to land
    // its readings — otherwise every one of them fails the FK.
    for (const hot of [
      "point_readings",
      "point_readings_agg_5m",
      "point_readings_agg_1d",
    ]) {
      expect(names.indexOf("points")).toBeLessThan(names.indexOf(hot));
    }
    // area_bindings.point_uid and derivations.output_point_id both FK points.id.
    expect(names.indexOf("points")).toBeLessThan(
      names.indexOf("area_bindings"),
    );
    // points.id is deterministic (uuidv5, = point_info.point_uid) and identical across environments, so
    // it upserts by PK with no natural-key/excludeCols dance — like derivations.
    expect(manifest.find((t) => t.name === "points")).toMatchObject({
      mode: "full",
      onConflict: "update",
    });
    expect(manifest.find((t) => t.name === "points")).not.toHaveProperty(
      "excludeCols",
    );
    // Its id is deterministic (uuidv5 over area/kind/role), identical in both environments — so it
    // upserts by PK, with no natural-key/excludeCols dance.
    expect(manifest.find((t) => t.name === "derivations")).toMatchObject({
      mode: "full",
      onConflict: "update",
    });
    expect(manifest.find((t) => t.name === "derivations")).not.toHaveProperty(
      "excludeCols",
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
        // ["slug"] is not an index — it is the stable cross-env identity of a `legacy-share-*`
        // dashboard, whose legacy_id is NULL on both sides and whose dev owner reown has rewritten.
        uniqueKeys: [["legacy_id"], ["owner_user_id", "slug"], ["slug"]],
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
    expect(sql).toContain("(d.slug = s.slug)");
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

  // Regression: from 2026-07-25 every sync run aborted on
  // `devices_primary_area_id_areas_id_fk`, freezing liveone-dev. devices.primary_area_id and
  // derivations.area_id are NOT NULL / NO ACTION, so a drifted area that owns a dark-mirror device
  // can't be deleted — those rows must be MOVED to prod's uuid instead.
  it("realigns a drifted area by repointing its NOT NULL dependants, never deleting devices", async () => {
    const table = prodDevSyncManifest().find(
      (entry) => entry.name === "areas",
    )!;
    expect(table).toMatchObject({
      mode: "full",
      idDrift: {
        repoint: [
          { table: "devices", cols: ["primary_area_id"] },
          { table: "derivations", cols: ["area_id"] },
        ],
        neutralize: ["legacy_system_id", "slug"],
      },
    });
    // derivations must be repointed, NOT deleted — that preserves its derived_intervals (CASCADE).
    expect(
      (
        table as { idDrift: { children: Array<{ table: string }> } }
      ).idDrift.children.map((c) => c.table),
    ).not.toContain("derivations");

    const { prod, dev, devSql } = copyClients();
    await syncTable(
      prod,
      dev,
      table,
      new Map([
        ["areas", ["id", "owner_user_id", "legacy_system_id", "name", "slug"]],
      ]),
      new Map([["areas", ["id"]]]),
    );

    const sql = devSql.at(-1)!;
    // _drift must carry prod's PK too — it is the repoint target.
    expect(sql).toContain("s.id AS new_id");
    expect(sql).toContain(
      "UPDATE public.devices x SET primary_area_id = b.new_id FROM _drift b WHERE x.primary_area_id = b.id;",
    );
    expect(sql).toContain(
      "UPDATE public.derivations x SET area_id = b.new_id FROM _drift b WHERE x.area_id = b.id;",
    );

    // Ordering is load-bearing: neutralize → upsert → repoint → delete the drifted parent.
    const at = (needle: string) => {
      const i = sql.indexOf(needle);
      expect(i).toBeGreaterThan(-1);
      return i;
    };
    expect(at("SET legacy_system_id = NULL, slug = NULL")).toBeLessThan(
      at("INSERT INTO public.areas"),
    );
    expect(at("INSERT INTO public.areas")).toBeLessThan(
      at("UPDATE public.devices x SET primary_area_id"),
    );
    expect(at("UPDATE public.derivations x SET area_id")).toBeLessThan(
      at("DELETE FROM public.areas d USING _drift"),
    );

    // The unsafe alternative: cascading from devices/points would destroy live area_bindings of
    // OTHER areas, because area_bindings.point_uid can cross-reference a point under a different area.
    expect(sql).not.toContain("DELETE FROM public.devices");
    expect(sql).not.toContain("DELETE FROM public.points");
  });

  it("realigns drifted devices by neutralizing NOT NULL rid to a sentinel, not NULL", async () => {
    const table = prodDevSyncManifest().find(
      (entry) => entry.name === "devices",
    )!;
    // Nothing is cleared — points.device_id is NOT NULL and the points themselves are undeletable
    // (point_readings.point_rid → points.rid, ~13M rows). Every child moves instead.
    expect(table).toMatchObject({ mode: "full", idDrift: { children: [] } });
    expect(
      (
        table as { idDrift: { repoint?: Array<{ table: string }> } }
      ).idDrift.repoint?.map((c) => c.table),
    ).toEqual(["points", "area_members", "device_state", "legacy_handles"]);

    const { prod, dev, devSql } = copyClients();
    await syncTable(
      prod,
      dev,
      table,
      new Map([["devices", ["id", "rid", "owner_user_id", "name", "slug"]]]),
      new Map([["devices", ["id"]]]),
    );

    const sql = devSql.at(-1)!;
    // The whole point: `rid` is NOT NULL, so it CANNOT be freed by NULLing it the way areas frees
    // legacy_system_id. It is pushed into the negative range instead — disjoint from every staged prod
    // rid, and still distinct per drifted row because rid is unique.
    expect(sql).toContain("SET rid = -d.rid - 1, slug = NULL");
    expect(sql).not.toContain("rid = NULL");

    // All four children repoint onto prod's uuid; none is deleted.
    for (const child of [
      "points",
      "area_members",
      "device_state",
      "legacy_handles",
    ]) {
      expect(sql).toContain(
        `UPDATE public.${child} x SET device_id = b.new_id FROM _drift b WHERE x.device_id = b.id;`,
      );
      expect(sql).not.toContain(`DELETE FROM public.${child}`);
    }

    // Same load-bearing order as areas: neutralize (frees devices_rid_unique) → upsert (prod's row
    // lands, becoming the FK target) → repoint → delete the drifted parent.
    const at = (needle: string) => {
      const i = sql.indexOf(needle);
      expect(i).toBeGreaterThan(-1);
      return i;
    };
    expect(at("SET rid = -d.rid - 1")).toBeLessThan(
      at("INSERT INTO public.devices"),
    );
    expect(at("INSERT INTO public.devices")).toBeLessThan(
      at("UPDATE public.points x SET device_id"),
    );
    expect(at("UPDATE public.legacy_handles x SET device_id")).toBeLessThan(
      at("DELETE FROM public.devices d USING _drift"),
    );
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
      // Re-based by migration 0047 onto `area_bindings_unique (area_id, role, metric_type,
      // point_uid)`. Pinned here because ON CONFLICT names an index BY ITS COLUMNS: if this list and
      // the live index ever disagree the sync aborts at runtime with "no unique constraint matching".
      conflictCols: ["area_id", "role", "metric_type", "point_uid"],
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
            "point_uid",
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
      "ON CONFLICT (area_id, role, metric_type, point_uid) DO UPDATE",
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
