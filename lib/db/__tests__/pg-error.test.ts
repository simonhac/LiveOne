/**
 * The SQLSTATE-through-drizzle's-wrapper predicate (config-v4 Phase 14 STEP 0).
 *
 * This pins the exact shape that broke: drizzle ≥0.44 re-throws a failed query as a `DrizzleQueryError`
 * whose OWN `code` is undefined and whose `cause` is the `pg` error. Every `err.code === "23505"` check
 * in the repo was written against a bare `pg` error and silently stopped matching, turning documented
 * 409s into unhandled 500s.
 */
import { describe, it, expect } from "@jest/globals";
import {
  hasPgErrorCode,
  isPgUniqueViolation,
  isUniqueViolationOn,
  uniqueViolationDetail,
  violatedUniqueName,
} from "../pg-error";

/**
 * The real shape, transcribed from `liveone-dev` failures (2026-07-31).
 *
 * 🛑 The `undefined` fields are the POINT of this fixture, not padding. Stage 2b re-measured them by
 * forcing a violation of a genuine PRIMARY KEY (`share_tokens_pkey`) as well as of a `uniqueIndex`, and
 * `constraint`/`table`/`schema`/`column`/`dataType` are stripped in BOTH cases — PlanetScale's proxy
 * drops the object-identifying ErrorResponse fields for every error it forwards. `severity`, `code`,
 * `detail`, `file`, `line` and `routine` do survive. A fixture that populated `constraint` would make
 * every predicate here pass while the production code kept failing, which is exactly the class of
 * mistake that shipped this bug.
 */
function pgUniqueViolation(
  uniqueName: string,
  key: string,
): Error & { constraint?: string } {
  return Object.assign(
    new Error(`duplicate key value violates unique constraint "${uniqueName}"`),
    {
      code: "23505",
      severity: "ERROR",
      detail: `Key ${key} already exists.`,
      hint: undefined,
      position: undefined,
      schema: undefined,
      table: undefined,
      column: undefined,
      dataType: undefined,
      constraint: undefined,
      file: "nbtinsert.c",
      line: "666",
      routine: "_bt_check_unique",
    },
  );
}

/** The `DrizzleQueryError` wrapper drizzle ≥0.44 re-throws it inside. */
function drizzleWrap(pgError: Error): Error {
  return Object.assign(new Error("Failed query: insert into …"), {
    cause: pgError,
  });
}

function drizzleWrapped(code: string): Error {
  const pgError = Object.assign(
    pgUniqueViolation("x_unique", "(owner_user_id, slug)=(user_1, taken)"),
    { code },
  );
  return drizzleWrap(pgError);
}

describe("hasPgErrorCode / isPgUniqueViolation", () => {
  it("sees the SQLSTATE through drizzle's wrapper", () => {
    expect(isPgUniqueViolation(drizzleWrapped("23505"))).toBe(true);
    expect(hasPgErrorCode(drizzleWrapped("23503"), "23503")).toBe(true);
  });

  it("still matches a bare pg error (the pre-drizzle-0.44 shape)", () => {
    expect(
      isPgUniqueViolation(Object.assign(new Error("dup"), { code: "23505" })),
    ).toBe(true);
  });

  it("does not match a different SQLSTATE", () => {
    expect(isPgUniqueViolation(drizzleWrapped("23503"))).toBe(false);
    expect(
      isPgUniqueViolation(Object.assign(new Error("x"), { code: "42703" })),
    ).toBe(false);
  });

  it("survives a deeper cause chain", () => {
    const inner = Object.assign(new Error("pg"), { code: "23505" });
    const mid = Object.assign(new Error("mid"), { cause: inner });
    const outer = Object.assign(new Error("outer"), { cause: mid });
    expect(isPgUniqueViolation(outer)).toBe(true);
  });

  it("is total on junk and cannot loop forever on a cyclic cause", () => {
    expect(isPgUniqueViolation(null)).toBe(false);
    expect(isPgUniqueViolation(undefined)).toBe(false);
    expect(isPgUniqueViolation("23505")).toBe(false);
    expect(isPgUniqueViolation({})).toBe(false);
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(isPgUniqueViolation(cyclic)).toBe(false);
  });
});

/**
 * `violatedUniqueName` / `isUniqueViolationOn` — config-v4 Phase 14 stage 2b.
 *
 * Unwrapping the cause chain is NECESSARY BUT NOT SUFFICIENT: three of the four sites this stage fixed
 * also needed to tell WHICH unique was violated, and every one of them asked `err.constraint`, which is
 * always undefined here. These cases pin the message fallback that replaces it.
 */
describe("violatedUniqueName / isUniqueViolationOn", () => {
  // Each fixture is a violation actually forced against `liveone-dev`.
  const AREA_ALIAS = pgUniqueViolation(
    "areas_owner_alias_unique",
    "(owner_user_id, slug)=(p14-pgerr-owner, p14-pgerr-alias)",
  );
  const POINTS_PKEY = pgUniqueViolation(
    "points_pkey",
    "(id)=(00000000-0000-7000-8000-0000cccc0001)",
  );
  const POINTS_LOGICAL = pgUniqueViolation(
    "points_device_logical_metric_unique",
    "(device_id, logical_path, metric_type)=(019f…, solar, power)",
  );
  const SHARE_PKEY = pgUniqueViolation(
    "share_tokens_pkey",
    "(token)=(p14-pgerr-tok-z)",
  );

  it("reads the index name out of the message when `constraint` is stripped", () => {
    expect(AREA_ALIAS.constraint).toBeUndefined(); // the premise
    expect(violatedUniqueName(drizzleWrap(AREA_ALIAS))).toBe(
      "areas_owner_alias_unique",
    );
    expect(violatedUniqueName(drizzleWrap(POINTS_PKEY))).toBe("points_pkey");
    expect(violatedUniqueName(drizzleWrap(SHARE_PKEY))).toBe(
      "share_tokens_pkey",
    );
  });

  it("prefers `constraint` when a stock Postgres does supply it", () => {
    const withConstraint = Object.assign(
      new Error('duplicate key value violates unique constraint "wrong_name"'),
      { code: "23505", constraint: "areas_owner_alias_unique" },
    );
    expect(violatedUniqueName(drizzleWrap(withConstraint))).toBe(
      "areas_owner_alias_unique",
    );
  });

  it("discriminates between two uniques on the SAME table", () => {
    // The whole reason `mintPoint` cannot use a bare `isPgUniqueViolation`: a
    // `points_device_logical_metric_unique` clash must NOT be retried with a random uid.
    expect(isUniqueViolationOn(drizzleWrap(POINTS_PKEY), "points_pkey")).toBe(
      true,
    );
    expect(
      isUniqueViolationOn(drizzleWrap(POINTS_LOGICAL), "points_pkey"),
    ).toBe(false);
    expect(isPgUniqueViolation(drizzleWrap(POINTS_LOGICAL))).toBe(true); // …but it IS a 23505
  });

  it("is strict: a 23505 with no determinable name matches nothing", () => {
    const anonymous = Object.assign(new Error("duplicate key value"), {
      code: "23505",
    });
    expect(violatedUniqueName(drizzleWrap(anonymous))).toBeUndefined();
    expect(isUniqueViolationOn(drizzleWrap(anonymous), "points_pkey")).toBe(
      false,
    );
  });

  it("returns undefined for a non-unique error and for junk", () => {
    const fk = Object.assign(new Error('violates foreign key constraint "f"'), {
      code: "23503",
    });
    expect(violatedUniqueName(drizzleWrap(fk))).toBeUndefined();
    expect(violatedUniqueName(null)).toBeUndefined();
    expect(violatedUniqueName("points_pkey")).toBeUndefined();
    expect(isUniqueViolationOn(undefined, "points_pkey")).toBe(false);
  });

  it("surfaces the pg `detail` for diagnostics, through the wrapper", () => {
    expect(uniqueViolationDetail(drizzleWrap(AREA_ALIAS))).toBe(
      "Key (owner_user_id, slug)=(p14-pgerr-owner, p14-pgerr-alias) already exists.",
    );
    expect(uniqueViolationDetail(drizzleWrap(POINTS_PKEY))).toContain("(id)=(");
    expect(uniqueViolationDetail(new Error("x"))).toBeUndefined();
  });
});
