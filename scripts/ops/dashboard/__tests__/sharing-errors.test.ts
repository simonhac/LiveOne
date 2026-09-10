import { describe, it, expect } from "@jest/globals";
import { SHARE_ERRORS } from "../sharing/handlers";

/**
 * The 409 renderer.
 *
 * It exists because the referential-integrity gate (lib/integrity) started returning 409 from
 * `DELETE /api/v4/dashboards/{id}`, and the shared handler in `lib/cli-kit/http.ts` answers a 409
 * with "the value collides with something that already exists — pick a different slug". That is
 * written for an alias collision: it points the operator at the wrong field AND discards
 * `detail.dependents`, which is the only part of the refusal worth reading.
 */
const why409 = SHARE_ERRORS[409].why;

describe("SHARE_ERRORS[409]", () => {
  it("names every dependent, with the column the reference lives in", () => {
    const out = why409({
      error: "That dashboard is still relied upon by 2 thing(s)",
      detail: {
        code: "relied-upon",
        dependents: [
          {
            kind: "share-token",
            id: "…zx91qp",
            name: "solar open day",
            via: "share_tokens.dashboard_id",
            effect: "cascade-deleted",
            fix: "revoke the link first",
          },
          {
            kind: "user",
            id: "user_2b",
            name: null,
            via: "users.default_dashboard_id",
            effect: "cleared",
            fix: "set that user a different default",
          },
        ],
      },
    });
    expect(out).toContain("share-token solar open day (…zx91qp)");
    expect(out).toContain("via share_tokens.dashboard_id, cascade-deleted");
    // An unnamed dependent still renders, without an empty gap where the name would be.
    expect(out).toContain("user (user_2b) — via users.default_dashboard_id");
    expect(out).not.toContain("slug");
  });

  it("falls back to the server's message when the refusal is some other 409", () => {
    expect(why409({ error: "That shortname is already in use" })).toBe(
      "That shortname is already in use",
    );
    expect(why409({ error: "nope", detail: { dependents: [] } })).toBe("nope");
    expect(why409({})).toBe("conflict");
  });

  it("says nothing was written, because nothing was", () => {
    expect(SHARE_ERRORS[409].next).toContain("nothing was written");
  });
});
