import { expect, it, jest } from "@jest/globals";
import { PgDialect } from "drizzle-orm/pg-core";
import { Point } from "@/lib/ids";
import { ReadingsDao } from "../dao";
jest.mock("@/lib/db/planetscale", () => ({ requirePlanetscaleDb: jest.fn() }));
jest.mock("@/lib/registry", () => ({
  RegistryCache: { ridForPoint: async () => 42 },
}));
it("bounds SQL by point, measurement window, ingestion cutoff and exact cursor before limiting", async () => {
  let predicate: any;
  let limit: number | undefined;
  const exec = {
    select: () => ({
      from: () => ({
        where: (where: unknown) => {
          predicate = where;
          return {
            orderBy: () => ({
              limit: (n: number) => {
                limit = n;
                return Promise.resolve([]);
              },
            }),
          };
        },
      }),
    }),
  };
  const window = {
    start: "2026-01-01T00:00:00Z",
    end: "2026-01-01T01:00:00Z",
    asOf: "2026-01-01T02:00:00Z",
    cursor: "2026-01-01T00:00:00.000001Z",
    limit: 500,
  };
  await ReadingsDao.readTrialReferencePage(
    Point.encode("11111111-1111-4111-8111-111111111111"),
    window,
    exec as never,
  );
  const query = new PgDialect().sqlToQuery(predicate);
  expect(query.params).toEqual([
    42,
    window.start,
    window.end,
    window.asOf,
    window.cursor,
  ]);
  expect(query.sql).toContain('"point_rid" =');
  expect(query.sql).toContain('"measurement_time" >=');
  expect(query.sql).toContain('"measurement_time" <');
  expect(query.sql).toContain('"created_at" <=');
  expect(query.sql).toContain('"measurement_time" >');
  expect(limit).toBe(501);
});
