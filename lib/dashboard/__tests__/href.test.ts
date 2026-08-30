import { describe, expect, it } from "@jest/globals";
import { dashboardHref } from "../href";

describe("dashboardHref", () => {
  const id = "db_01kyf18tp3e5brm474zf0fzvkm";

  it("builds the pretty form when slug and owner username are both known", () => {
    expect(
      dashboardHref({ id, slug: "daylesford", ownerUsername: "simon" }),
    ).toBe("/dashboard/simon/daylesford");
  });

  it("falls back to the id form without a slug", () => {
    expect(dashboardHref({ id, slug: null, ownerUsername: "simon" })).toBe(
      `/dashboard/${id}`,
    );
  });

  it("falls back to the id form without an owner username", () => {
    expect(dashboardHref({ id, slug: "daylesford", ownerUsername: null })).toBe(
      `/dashboard/${id}`,
    );
    expect(dashboardHref({ id })).toBe(`/dashboard/${id}`);
  });
});
