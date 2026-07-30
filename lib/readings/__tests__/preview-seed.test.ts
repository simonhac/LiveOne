import { describe, expect, it } from "@jest/globals";
import { seedPreviewDatabase, type PreviewSeedRuntime } from "../preview-seed";

const SOURCE = "postgres://source_user:source_secret@source.example/db";
const TARGET = "postgres://target_user:target_secret@target.example/db";

function runtime(deviceCount: number, fk = "readings_session_fk") {
  const calls: Array<{
    file: string;
    args: readonly string[];
    env?: NodeJS.ProcessEnv;
  }> = [];
  const removed: string[] = [];
  const execFileSync = ((
    file: string,
    args: readonly string[],
    options?: { env?: NodeJS.ProcessEnv },
  ) => {
    calls.push({ file, args, env: options?.env });
    const statement = args.at(-1) ?? "";
    if (statement.includes("FROM pg_constraint")) return fk;
    if (statement === "SELECT count(*) FROM devices")
      return String(deviceCount);
    if (statement.includes("SELECT 'sessions='")) return "sessions=7";
    return "";
  }) as PreviewSeedRuntime["execFileSync"];
  const fake: PreviewSeedRuntime = {
    execFileSync,
    unlinkSync: ((path: string) => removed.push(path)) as never,
    tmpdir: () => "/tmp",
  };
  return { fake, calls, removed };
}

describe("preview readings transfer", () => {
  it("preserves FK/config/slice ordering and keeps credentials out of argv", async () => {
    const { fake, calls, removed } = runtime(0);
    const logs: string[] = [];
    await expect(
      seedPreviewDatabase(
        {
          sourceUrl: SOURCE,
          targetUrl: TARGET,
          seedDays: 10,
          seedDaysDaily: 45,
          onProgress: (message) => logs.push(message),
        },
        fake,
      ),
    ).resolves.toEqual({ counts: "sessions=7" });

    const statements = calls.map((call) => call.args.at(-1) ?? "");
    expect(statements[0]).toContain("FROM pg_constraint");
    expect(statements[1]).toContain("ALTER TABLE point_readings");
    expect(statements[2]).toBe("SELECT count(*) FROM devices");
    expect(statements).toContainEqual(
      expect.stringContaining(
        "TRUNCATE sessions, point_readings, point_readings_agg_5m, point_readings_agg_1d",
      ),
    );
    expect(statements).toContainEqual(
      expect.stringContaining("measurement_time >= "),
    );
    expect(statements).toContainEqual(
      expect.stringContaining("interval_end >= "),
    );
    // Every copied table leaves exactly one temp file behind, in copy order — so `removed` IS the
    // copy order. Assert the FK edges that actually bite rather than a bare count: a parent copied
    // after its child fails the FK at COPY time, which is how the list went stale at the cutover
    // (devices/points were missing entirely, so the point_readings copy had nothing to reference).
    const order = removed.map((p) =>
      p.replace("/tmp/seed_", "").replace(".bin", ""),
    );
    const before = (parent: string, child: string) => {
      expect(order).toContain(parent);
      expect(order).toContain(child);
      expect(order.indexOf(parent)).toBeLessThan(order.indexOf(child));
    };
    before("areas", "devices"); // devices.primary_area_id
    before("devices", "points"); // points.device_id
    before("devices", "device_state"); // device_state.device_id
    before("devices", "legacy_handles"); // legacy_handles.device_id
    before("areas", "area_members");
    before("devices", "area_members");
    // `before("devices", "point_info")` retired: migration 0051 dropped both tables.
    before("areas", "area_bindings"); // area_bindings.area_id
    before("dashboards", "users"); // users.default dashboard
    before("points", "point_readings"); // the hot-table rid FK — the copy this fix unblocks
    before("sessions", "point_readings");
    // Config first, then the time-series slice.
    expect(order.indexOf("share_tokens")).toBeLessThan(
      order.indexOf("sessions"),
    );
    expect(JSON.stringify(statements)).not.toContain("source_secret");
    expect(JSON.stringify(statements)).not.toContain("target_secret");
    expect(calls.some((call) => call.env?.PGPASSWORD === "source_secret")).toBe(
      true,
    );
    expect(calls.some((call) => call.env?.PGPASSWORD === "target_secret")).toBe(
      true,
    );
    expect(logs.at(-1)).toContain("sessions=7");
  });

  it("skips config copies when the target already has devices", async () => {
    const { fake, calls, removed } = runtime(16, "");
    await seedPreviewDatabase(
      {
        sourceUrl: SOURCE,
        targetUrl: TARGET,
        seedDays: 3,
        seedDaysDaily: 30,
      },
      fake,
    );

    const statements = calls.map((call) => call.args.at(-1) ?? "");
    expect(
      statements.some((statement) =>
        statement.includes("\\copy (SELECT * FROM devices"),
      ),
    ).toBe(false);
    expect(removed).toHaveLength(6);
  });
});
