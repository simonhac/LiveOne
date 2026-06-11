import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";

/**
 * Phase 5 decommissioned Turso, so the staged-migration flags (`CONFIG_*`,
 * `READINGS_READS_FROM_PG`, `AGG_COMPUTE_IN_PG`, `WRITE_OUTBOX`) are retired. The only
 * surviving routing flags gate the not-yet-enabled energy-flow-matrix rollout.
 *
 * Flags are evaluated at module load, so each case sets env then re-imports the module in
 * isolation.
 */
function loadRouting(env: Record<string, string | undefined>) {
  let mod!: typeof import("../routing");
  jest.isolateModules(() => {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    mod = require("../routing");
  });
  return mod;
}

const FLAG_VARS = ["FLOW_MATRIX_COMPUTE_IN_PG", "FLOW_MATRIX_SERVE_FROM_PG"];

describe("db routing flags", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const v of FLAG_VARS) saved[v] = process.env[v];
  });

  afterEach(() => {
    for (const v of FLAG_VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  it("dbRoutingFlags() reports both surviving flags, defaulting to false when unset", () => {
    const r = loadRouting(
      Object.fromEntries(FLAG_VARS.map((v) => [v, undefined])),
    );
    expect(r.dbRoutingFlags()).toEqual({
      FLOW_MATRIX_COMPUTE_IN_PG: false,
      FLOW_MATRIX_SERVE_FROM_PG: false,
    });
  });

  it('treats exactly "true" (case-insensitive, trimmed) as the only truthy value', () => {
    expect(
      loadRouting({ FLOW_MATRIX_COMPUTE_IN_PG: "true" })
        .FLOW_MATRIX_COMPUTE_IN_PG,
    ).toBe(true);
    expect(
      loadRouting({ FLOW_MATRIX_COMPUTE_IN_PG: "TRUE" })
        .FLOW_MATRIX_COMPUTE_IN_PG,
    ).toBe(true);
    expect(
      loadRouting({ FLOW_MATRIX_COMPUTE_IN_PG: "  true  " })
        .FLOW_MATRIX_COMPUTE_IN_PG,
    ).toBe(true);
  });

  it("treats other truthy-looking values as false", () => {
    for (const val of ["1", "yes", "on", "false", "", "0"]) {
      expect(
        loadRouting({ FLOW_MATRIX_COMPUTE_IN_PG: val })
          .FLOW_MATRIX_COMPUTE_IN_PG,
      ).toBe(false);
    }
  });

  it("reads each flag independently", () => {
    const r = loadRouting({
      FLOW_MATRIX_COMPUTE_IN_PG: "true",
      FLOW_MATRIX_SERVE_FROM_PG: undefined,
    });
    expect(r.FLOW_MATRIX_COMPUTE_IN_PG).toBe(true);
    expect(r.FLOW_MATRIX_SERVE_FROM_PG).toBe(false);

    const r2 = loadRouting({
      FLOW_MATRIX_COMPUTE_IN_PG: undefined,
      FLOW_MATRIX_SERVE_FROM_PG: "true",
    });
    expect(r2.FLOW_MATRIX_COMPUTE_IN_PG).toBe(false);
    expect(r2.FLOW_MATRIX_SERVE_FROM_PG).toBe(true);
  });
});
