/**
 * The target guard is the only thing standing between `config-transform.ts --commit` and the wrong
 * database, so its refusals are behaviour, not defensive noise — and they are exercised exactly once per
 * cutover, at 3am, by an operator under time pressure. Pin them.
 *
 * The three modes exist because the original guard hard-required `REHEARSAL_BRANCH_ID` and refused the
 * prod token outright: there was NO sanctioned way to run the cutover scripts in either the dev or the
 * prod window, so the only route was to set `REHEARSAL_BRANCH_ID` to the prod branch id — which defeats
 * the guard and is indistinguishable from doing it by accident.
 */
import { describe, expect, it, beforeEach, afterAll } from "@jest/globals";
import { assertRehearsalTarget } from "../guard";

const KEYS = [
  "CONFIG_V4_TARGET",
  "REHEARSAL_BRANCH_ID",
  "LIVEONE_DEV_BRANCH_ID",
  "PLANETSCALE_PROD_BRANCH_ID",
  "PLANETSCALE_DATABASE_URL",
] as const;

const origEnv = { ...process.env };
const origArgv = process.argv;

/** PlanetScale puts every branch in a region on ONE host and distinguishes them by the USERNAME. */
const connAs = (branchId: string) =>
  `postgres://postgres.${branchId}:pw@aws-ap-southeast-2-1.pg.psdb.cloud/liveone`;

function target(
  env: Partial<Record<(typeof KEYS)[number], string>>,
  argv: string[] = [],
) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  process.argv = ["node", "script", ...argv];
  return () => assertRehearsalTarget();
}

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
});
afterAll(() => {
  process.env = origEnv;
  process.argv = origArgv;
});

/** Present in every valid invocation — the guard cannot identify prod without it. */
const PROD = { PLANETSCALE_PROD_BRANCH_ID: "br-prod" };

describe("assertRehearsalTarget", () => {
  it("accepts a rehearsal branch whose id is in the connection username", () => {
    expect(
      target({
        ...PROD,
        REHEARSAL_BRANCH_ID: "br-rehearse",
        PLANETSCALE_DATABASE_URL: connAs("br-rehearse"),
      }),
    ).not.toThrow();
  });

  it("refuses a rehearsal run pointed at a different branch", () => {
    expect(
      target({
        ...PROD,
        REHEARSAL_BRANCH_ID: "br-rehearse",
        PLANETSCALE_DATABASE_URL: connAs("br-other"),
      }),
    ).toThrow(/does not carry REHEARSAL_BRANCH_ID/);
  });

  it("refuses when no positive confirmation is supplied at all", () => {
    expect(
      target({ ...PROD, PLANETSCALE_DATABASE_URL: connAs("br-rehearse") }),
    ).toThrow(/set REHEARSAL_BRANCH_ID/);
  });

  // The fail-open that mattered most: without the prod token the guard cannot tell prod from anything
  // else, so on a CI runner or a partial .env.local a rehearsal-mode run against the prod URL used to
  // sail straight through. Every mode now refuses.
  it.each(["rehearsal", "dev", "prod"])(
    "refuses in %s mode when PLANETSCALE_PROD_BRANCH_ID is unset (cannot identify prod)",
    (mode) => {
      expect(
        target(
          {
            CONFIG_V4_TARGET: mode,
            REHEARSAL_BRANCH_ID: "br-prod",
            LIVEONE_DEV_BRANCH_ID: "br-prod",
            PLANETSCALE_DATABASE_URL: connAs("br-prod"),
          },
          ["--i-understand-this-is-prod"],
        ),
      ).toThrow(/PLANETSCALE_PROD_BRANCH_ID is unset/);
    },
  );

  it("refuses prod even when REHEARSAL_BRANCH_ID is set to the prod branch id", () => {
    // The specific bypass the modes exist to close.
    expect(
      target({
        REHEARSAL_BRANCH_ID: "br-prod",
        PLANETSCALE_PROD_BRANCH_ID: "br-prod",
        PLANETSCALE_DATABASE_URL: connAs("br-prod"),
      }),
    ).toThrow(/carries the PROD branch token/);
  });

  it("accepts liveone-dev under CONFIG_V4_TARGET=dev", () => {
    expect(
      target({
        ...PROD,
        CONFIG_V4_TARGET: "dev",
        LIVEONE_DEV_BRANCH_ID: "br-dev",
        PLANETSCALE_DATABASE_URL: connAs("br-dev"),
      }),
    ).not.toThrow();
  });

  it("refuses a dev-mode run that actually points at prod", () => {
    expect(
      target({
        CONFIG_V4_TARGET: "dev",
        LIVEONE_DEV_BRANCH_ID: "br-prod",
        PLANETSCALE_PROD_BRANCH_ID: "br-prod",
        PLANETSCALE_DATABASE_URL: connAs("br-prod"),
      }),
    ).toThrow(/carries the PROD branch token/);
  });

  it("refuses prod mode without the explicit flag", () => {
    expect(
      target({
        CONFIG_V4_TARGET: "prod",
        PLANETSCALE_PROD_BRANCH_ID: "br-prod",
        PLANETSCALE_DATABASE_URL: connAs("br-prod"),
      }),
    ).toThrow(/--i-understand-this-is-prod/);
  });

  it("accepts prod mode with the flag AND a genuinely prod connection", () => {
    expect(
      target(
        {
          CONFIG_V4_TARGET: "prod",
          PLANETSCALE_PROD_BRANCH_ID: "br-prod",
          PLANETSCALE_DATABASE_URL: connAs("br-prod"),
        },
        ["--i-understand-this-is-prod"],
      ),
    ).not.toThrow();
  });

  it("refuses prod mode when the connection is NOT prod (a mistyped URL in the window)", () => {
    expect(
      target(
        {
          CONFIG_V4_TARGET: "prod",
          PLANETSCALE_PROD_BRANCH_ID: "br-prod",
          PLANETSCALE_DATABASE_URL: connAs("br-dev"),
        },
        ["--i-understand-this-is-prod"],
      ),
    ).toThrow(/does NOT carry the prod branch token/);
  });
});
