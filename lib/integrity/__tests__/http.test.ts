import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import type { NextRequest } from "next/server";

jest.mock("../relied-upon", () => ({ findDependents: jest.fn() }));

import { findDependents, type Dependent } from "../relied-upon";
import { refuseIfReliedUpon } from "../http";

/**
 * The gate that decides whether a delete happens. Small surface, and every branch of it is a
 * different thing happening to somebody's data, so all four are pinned.
 */
const mockFind = jest.mocked(findDependents);

const req = (url: string) => ({ nextUrl: new URL(url) }) as NextRequest;

const dependent: Dependent = {
  kind: "dashboard",
  id: "db_01aaaaaaaaaaaaaaaaaaaaaaaa",
  name: "Home",
  via: "dashboards.doc → node.area",
  effect: "silently-dropped",
  fix: "re-point that node",
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("refuseIfReliedUpon", () => {
  it("proceeds when nothing depends on the row", async () => {
    mockFind.mockResolvedValue([]);
    const out = await refuseIfReliedUpon(
      req("https://x/api/v4/areas/ar_1"),
      "area",
      "uuid-1",
    );
    expect(out).toEqual({ forced: [] });
  });

  it("409s and NAMES every dependent, rather than counting them", async () => {
    mockFind.mockResolvedValue([dependent]);
    const out = await refuseIfReliedUpon(
      req("https://x/api/v4/areas/ar_1"),
      "area",
      "uuid-1",
    );
    expect("response" in out).toBe(true);
    if (!("response" in out)) throw new Error("unreachable");
    expect(out.response.status).toBe(409);
    const body = await out.response.json();
    expect(body.detail.code).toBe("relied-upon");
    // The whole point: `via` survives to the caller. A bare count is what made two prod incidents
    // unexplainable.
    expect(body.detail.dependents).toEqual([dependent]);
  });

  it("proceeds under ?force=true, and hands the list back so the override is legible", async () => {
    mockFind.mockResolvedValue([dependent]);
    const out = await refuseIfReliedUpon(
      req("https://x/api/v4/areas/ar_1?force=true"),
      "area",
      "uuid-1",
    );
    expect(out).toEqual({ forced: [dependent] });
  });

  it("does not accept any other spelling of force", async () => {
    mockFind.mockResolvedValue([dependent]);
    for (const q of ["?force=1", "?force", "?force=yes", "?force=TRUE"]) {
      const out = await refuseIfReliedUpon(
        req(`https://x/api/v4/areas/ar_1${q}`),
        "area",
        "uuid-1",
      );
      expect("response" in out ? "refused" : `accepted ${q}`).toBe("refused");
    }
  });
});
