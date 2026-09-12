import { describe, expect, it } from "@jest/globals";
import { referencePage, referenceQuery } from "../reference-export";
const query = {
  pollerId: "11111111-1111-4111-8111-111111111111",
  pointId: "22222222-2222-4222-8222-222222222222",
  revision: "2",
  start: "2026-01-01T00:00:00Z",
  end: "2026-01-01T01:00:00Z",
  asOf: "2026-01-01T02:00:00Z",
};
describe("bounded reference export", () => {
  it("requires a fixed cutoff and bounded completed window", () => {
    expect(referenceQuery.parse(query).limit).toBe(500);
    for (const change of [
      { asOf: undefined },
      { asOf: query.start },
      { end: "2026-01-02T00:00:00Z" },
      { limit: "1001" },
      { cursor: query.end },
      { start: "invalid" },
      { deviceId: "unscoped" },
    ]) {
      expect(referenceQuery.safeParse({ ...query, ...change }).success).toBe(
        false,
      );
    }
  });
  it("preserves microsecond cursor precision and terminal pages", () => {
    const rows = ["000001", "000002", "000003"].map((us) => ({
      timestamp: `2026-01-01T00:00:00.${us}Z`,
      value: 0,
    }));
    const page = referencePage(rows, 2);
    expect(page.nextCursor).toBe(rows[1].timestamp);
    expect(
      referenceQuery.parse({ ...query, cursor: page.nextCursor }).cursor,
    ).toBe(rows[1].timestamp);
    expect(referencePage(rows.slice(2), 2).nextCursor).toBeNull();
    expect(referencePage([], 2).readings).toEqual([]);
    expect(page.readings[0].value).toBe(0);
  });
});
