/**
 * The SQLSTATE-through-drizzle's-wrapper predicate (config-v4 Phase 14 STEP 0).
 *
 * This pins the exact shape that broke: drizzle ≥0.44 re-throws a failed query as a `DrizzleQueryError`
 * whose OWN `code` is undefined and whose `cause` is the `pg` error. Every `err.code === "23505"` check
 * in the repo was written against a bare `pg` error and silently stopped matching, turning documented
 * 409s into unhandled 500s.
 */
import { describe, it, expect } from "@jest/globals";
import { hasPgErrorCode, isPgUniqueViolation } from "../pg-error";

/** The real shape, copied from a `liveone-dev` failure (2026-07-31). */
function drizzleWrapped(code: string): Error {
  const pgError = Object.assign(
    new Error('duplicate key value violates unique constraint "x_unique"'),
    {
      code,
      severity: "ERROR",
      detail: "Key (owner_user_id, slug)=(user_1, taken) already exists.",
      // Measured: PlanetScale Postgres leaves these EMPTY for a unique-INDEX violation, which is why
      // nothing here may key off `constraint`.
      constraint: undefined,
      table: undefined,
      schema: undefined,
    },
  );
  return Object.assign(new Error("Failed query: insert into …"), {
    cause: pgError,
  });
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
