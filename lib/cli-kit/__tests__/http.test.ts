/**
 * The HTTP client's error vocabulary. Each branch exists because the raw status is ambiguous at
 * the terminal — the mapped what/why/next is the interface, so it is pinned here with an injected
 * fetch (no network).
 */
import { describe, it, expect } from "@jest/globals";
import { apiFetch, DocInvalidError } from "../http";
import { CliFailure } from "@/lib/cli/cli";

const respond = (
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {},
): typeof fetch =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    })) as unknown as typeof fetch;

const call = (fetchImpl: typeof fetch, init: Record<string, unknown> = {}) =>
  apiFetch("https://www.liveone.energy", "/api/v4/dashboards", {
    fetchImpl,
    ...init,
  });

async function failure(p: Promise<unknown>): Promise<CliFailure["detail"]> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CliFailure) return e.detail;
    throw e;
  }
  throw new Error("expected a CliFailure");
}

describe("success", () => {
  it("returns the body and the unquoted ETag revision", async () => {
    const ok = await call(respond(200, { hello: 1 }, { etag: '"7"' }));
    expect(ok.body).toEqual({ hello: 1 });
    expect(ok.etagRevision).toBe(7);
  });

  it("sends If-Match quoted, and the bearer", async () => {
    let seen: Record<string, string> = {};
    const spy: typeof fetch = (async (_url: unknown, init: RequestInit) => {
      seen = Object.fromEntries(
        Object.entries(init.headers as Record<string, string>),
      );
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await call(spy, { ifMatch: 4, token: "lo_cli_x.y" });
    expect(seen["if-match"]).toBe('"4"');
    expect(seen.authorization).toBe("Bearer lo_cli_x.y");
  });
});

describe("the ambiguous statuses, disambiguated", () => {
  it("REFUSES a redirect rather than following it into a stripped auth header", async () => {
    const d = await failure(call(respond(307, {}, { location: "https://x" })));
    expect(d.code).toBe(2);
    expect(d.next).toContain("www.liveone.energy");
  });

  it("distinguishes the edge protect-rewrite 404 from a real 404", async () => {
    const edge = await failure(
      call(respond(404, {}, { "x-clerk-auth-reason": "protect-rewrite" })),
    );
    expect(edge.code).toBe(3);
    expect(edge.why).toContain("middleware 404-rewrote");

    const real = await failure(call(respond(404, { error: "Not found" })));
    expect(real.code).toBe(1);
    expect(real.next).toContain("per-environment");
  });

  it("maps 401 to exit 3 with the login command", async () => {
    const d = await failure(call(respond(401, { error: "Unauthorized" })));
    expect(d.code).toBe(3);
    expect(d.next).toContain("liveone auth login");
  });

  it("maps 403 to findings, naming --via=db as the repair path", async () => {
    const d = await failure(
      call(
        respond(403, {
          error: "The doc references an area or device you cannot read",
        }),
      ),
    );
    expect(d.code).toBe(1);
    expect(d.what).toContain("cannot read");
    expect(d.next).toContain("--via=db");
  });

  it("maps 412 with the server's current revision", async () => {
    const d = await failure(
      call(respond(412, { error: "revision-conflict", current: 9 })),
    );
    expect(d.code).toBe(1);
    expect(d.why).toContain("revision 9");
  });

  it("throws DocInvalidError carrying the 422 issues intact", async () => {
    const issues = {
      errors: [{ path: "root", code: "x", message: "bad" }],
      warnings: [],
    };
    await expect(call(respond(422, issues))).rejects.toMatchObject({
      name: "DocInvalidError",
      rejection: issues,
    });
  });

  it("maps an unreachable origin to upstream with a dev-server hint", async () => {
    const boom: typeof fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const d = await failure(call(boom));
    expect(d.code).toBe(5);
    expect(d.next).toContain("dev server");
  });
});

describe("per-call error overrides", () => {
  it("replaces the default mapping for one status", async () => {
    // A 409 from cli-auth/exchange is the live-token cap, not the slug collision the default
    // message assumes. The override is what lets that caller stay on this client.
    const d = await failure(
      call(respond(409, { error: "too many live CLI tokens" }), {
        errors: {
          409: {
            exit: 1,
            what: "token cap reached",
            why: (b: Record<string, unknown>) => String(b.error),
            next: "run `liveone auth revoke --all`",
          },
        },
      }),
    );
    expect(d.what).toBe("token cap reached");
    expect(d.why).toBe("too many live CLI tokens");
    expect(d.next).toMatch(/revoke --all/);
  });

  it("leaves the shared vocabulary in place for every other status", async () => {
    // The reason to override rather than hand-roll a second fetch: the redirect refusal and the
    // protect-rewrite diagnosis still apply to a caller that only wanted a different 409.
    const d = await failure(
      call(respond(307), {
        errors: {
          409: {
            exit: 1,
            what: "unused",
            why: () => "unused",
            next: "unused",
          },
        },
      }),
    );
    expect(d.what).toMatch(/redirects/);
  });
});
