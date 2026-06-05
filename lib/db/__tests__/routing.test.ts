import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";

/**
 * Flags are evaluated at module load, so each case sets env then re-imports the
 * module in isolation.
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

const FLAG_VARS = [
  "CONFIG_READS_FROM_PG",
  "CONFIG_WRITES_TO_PG",
  "READINGS_READS_FROM_PG",
  "AGG_COMPUTE_IN_PG",
];

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

  it("defaults every flag to false when unset", () => {
    const r = loadRouting(
      Object.fromEntries(FLAG_VARS.map((v) => [v, undefined])),
    );
    expect(r.dbRoutingFlags()).toEqual({
      CONFIG_READS_FROM_PG: false,
      CONFIG_WRITES_TO_PG: false,
      READINGS_READS_FROM_PG: false,
      AGG_COMPUTE_IN_PG: false,
    });
  });

  it('treats exactly "true" (case-insensitive, trimmed) as the only truthy value', () => {
    expect(
      loadRouting({ CONFIG_READS_FROM_PG: "true" }).CONFIG_READS_FROM_PG,
    ).toBe(true);
    expect(
      loadRouting({ CONFIG_READS_FROM_PG: "TRUE" }).CONFIG_READS_FROM_PG,
    ).toBe(true);
    expect(
      loadRouting({ CONFIG_READS_FROM_PG: "  true  " }).CONFIG_READS_FROM_PG,
    ).toBe(true);
  });

  it("treats other truthy-looking values as false", () => {
    for (const val of ["1", "yes", "on", "false", "", "0"]) {
      expect(loadRouting({ AGG_COMPUTE_IN_PG: val }).AGG_COMPUTE_IN_PG).toBe(
        false,
      );
    }
  });

  it("reads each flag independently", () => {
    const r = loadRouting({
      CONFIG_READS_FROM_PG: undefined,
      CONFIG_WRITES_TO_PG: "true",
      READINGS_READS_FROM_PG: undefined,
      AGG_COMPUTE_IN_PG: "true",
    });
    expect(r.CONFIG_WRITES_TO_PG).toBe(true);
    expect(r.AGG_COMPUTE_IN_PG).toBe(true);
    expect(r.CONFIG_READS_FROM_PG).toBe(false);
    expect(r.READINGS_READS_FROM_PG).toBe(false);
  });
});
