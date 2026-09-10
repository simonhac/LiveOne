/**
 * The parts of ownership transfer that decide whether a write is SAFE, exercised without a database.
 *
 * The transactional write itself is covered by the route's contract; what is worth pinning here is
 * the request parsing, because every one of these is a body that would otherwise reach the writer
 * meaning something other than what the caller intended.
 */
import { describe, it, expect } from "@jest/globals";
import { parseIdList, parseShareBack } from "../transfer";

describe("parsing an id list", () => {
  it("treats absent and empty as 'none', not as an error", () => {
    // A transfer that names only dashboards must not have to send `devices: []`.
    expect(parseIdList(undefined)).toEqual([]);
    expect(parseIdList(null)).toEqual([]);
    expect(parseIdList([])).toEqual([]);
  });

  it("refuses a non-array rather than coercing it to an empty list", () => {
    // 🛑 Coercing `{}` to [] is the dangerous direction: the transfer would move nothing and report
    // success, which is indistinguishable from "there was nothing to move".
    expect(parseIdList("dv_x")).toBeNull();
    expect(parseIdList({})).toBeNull();
    expect(parseIdList([1, 2])).toBeNull();
  });
});

describe("parsing the share-back", () => {
  it("reads a bare user id as the LEAST role it could mean", () => {
    // 🛑 `["user_x"]` is ambiguous between viewer and admin. Defaulting to admin would silently
    // hand edit rights to someone the caller only meant to keep informed.
    expect(parseShareBack(["user_x"], "viewer")).toEqual([
      { userId: "user_x", role: "viewer" },
    ]);
  });

  it("lets an explicit role override the fallback, per entry", () => {
    expect(
      parseShareBack(["user_a", { userId: "user_b", role: "admin" }], "viewer"),
    ).toEqual([
      { userId: "user_a", role: "viewer" },
      { userId: "user_b", role: "admin" },
    ]);
  });

  it("refuses an unknown role instead of falling back to the default", () => {
    // Falling back would turn a typo'd "owner" into a viewer grant — a quiet demotion that reads as
    // success, on the one field that says what someone may do.
    expect(
      parseShareBack([{ userId: "user_b", role: "owner" }], "viewer"),
    ).toBeNull();
    expect(
      parseShareBack([{ userId: "user_b", role: "" }], "viewer"),
    ).toBeNull();
  });

  it("refuses an entry with no userId", () => {
    expect(parseShareBack([{ role: "admin" }], "viewer")).toBeNull();
    expect(parseShareBack([42], "viewer")).toBeNull();
  });

  it("treats absent as 'no share-back', which the writer then warns about", () => {
    // Not an error here: `--no-share-back` is a real, if dangerous, intent. The writer warns,
    // because only it knows whether devices are moving.
    expect(parseShareBack(undefined, "viewer")).toEqual([]);
  });
});
