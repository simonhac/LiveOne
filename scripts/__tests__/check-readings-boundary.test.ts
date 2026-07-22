import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Regression-tests the config-v4 Phase 3 readings-seam ratchet
 * (scripts/check-readings-boundary.mjs). There is no PR CI, so this is what guarantees the gate
 * itself keeps working: each evasion mode (static / aliased / dynamic import + raw-SQL) must be
 * flagged, and the known false positives (point_readings_flow_attr_1d, comments, the inline pragma)
 * must NOT be. Runs the real script as a subprocess (like lib/__tests__/route-slugs.test.ts) so it
 * exercises the file walk + detection + CLI end-to-end without ESM/CJS import friction.
 */
const repoRoot = join(__dirname, "..", "..");
const script = join(repoRoot, "scripts", "check-readings-boundary.mjs");

/** Run the boundary script over `roots` with no baseline; return {code, stderr, stdout}. */
function run(roots: string[]) {
  try {
    const stdout = execFileSync("node", [script, "--no-baseline", ...roots], {
      cwd: repoRoot,
      stdio: "pipe",
    }).toString();
    return { code: 0, stdout, stderr: "" };
  } catch (err: any) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

describe("check-readings-boundary", () => {
  it("passes over the live tree against the committed baseline (the real prebuild gate)", () => {
    // Default roots + real baseline (no --no-baseline): must exit 0.
    const out = execFileSync("node", [script], {
      cwd: repoRoot,
      stdio: "pipe",
    }).toString();
    expect(out).toMatch(/readings boundary green/);
  });

  describe("detection (temp fixtures, empty baseline)", () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "rb-offenders-"));
      writeFileSync(
        join(dir, "static.ts"),
        `import { pointReadingsAgg5m } from "@/lib/db/planetscale/schema";\n`,
      );
      writeFileSync(
        join(dir, "aliased.ts"),
        `import { pointReadingsAgg5m as pgAgg5m } from "@/lib/db/planetscale/schema";\n`,
      );
      writeFileSync(
        join(dir, "dynamic.ts"),
        `const { pointReadings } = await import("@/lib/db/planetscale/schema");\n`,
      );
      writeFileSync(
        join(dir, "relative.ts"),
        `import { pointReadingsAgg1d } from "./schema";\n`,
      );
      writeFileSync(
        join(dir, "rawsql.ts"),
        "await db.execute(sql`SELECT 1 FROM point_readings_agg_5m LIMIT 1`);\n",
      );
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("fails (exit 1) and names every offending file", () => {
      const { code, stderr } = run([dir]);
      expect(code).toBe(1);
      for (const f of [
        "static.ts",
        "aliased.ts",
        "dynamic.ts",
        "relative.ts",
        "rawsql.ts",
      ]) {
        expect(stderr).toContain(f);
      }
    });
  });

  describe("false-positive avoidance (temp fixtures, empty baseline)", () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "rb-clean-"));
      // Different table (out of scope) — the negative lookahead must reject it.
      writeFileSync(
        join(dir, "flow-attr.ts"),
        "await db.execute(sql`SELECT * FROM point_readings_flow_attr_1d`);\n",
      );
      // Comment-only mention.
      writeFileSync(
        join(dir, "comment.ts"),
        "// this reads point_readings_agg_5m elsewhere\nexport const x = 1;\n",
      );
      // Inline pragma on a prose/log line.
      writeFileSync(
        join(dir, "pragma.ts"),
        "const msg = `wrote point_readings_agg_5m`; // readings-boundary-allow\n",
      );
      // A local variable named like the symbol (camelCase) is not an import → not flagged.
      writeFileSync(
        join(dir, "localvar.ts"),
        "const pointReadings = [];\nexport const n = pointReadings.length;\n",
      );
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it("passes (exit 0) — no false positives", () => {
      const { code, stderr } = run([dir]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
    });
  });
});
