import { describe, expect, it } from "@jest/globals";
import { seedPreviewDatabase, type PreviewSeedRuntime } from "../preview-seed";

const SOURCE = "postgres://source_user:source_secret@source.example/db";
const TARGET = "postgres://target_user:target_secret@target.example/db";

function runtime(systemsCount: number, fk = "readings_session_fk") {
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
    if (statement === "SELECT count(*) FROM systems")
      return String(systemsCount);
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
    expect(statements[2]).toBe("SELECT count(*) FROM systems");
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
    expect(removed).toHaveLength(12);
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

  it("skips config copies when the target already has systems", async () => {
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
        statement.includes("\\copy (SELECT * FROM systems"),
      ),
    ).toBe(false);
    expect(removed).toHaveLength(6);
  });
});
