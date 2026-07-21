import { describe, it, expect } from "@jest/globals";
import {
  makeTimer,
  serverTimingHeaders,
  forwardRequestHeader,
  MIDDLEWARE_DUR_HEADER,
} from "../server-timing";

/** Parse a Server-Timing header value into ordered [name, dur] pairs. */
function parse(header: string): [string, number][] {
  return header.split(", ").map((entry) => {
    const m = entry.match(/^([^;]+);dur=([\d.]+)$/);
    expect(m).not.toBeNull();
    return [m![1], Number(m![2])];
  });
}

describe("makeTimer", () => {
  it("records async spans in completion order and appends total", async () => {
    const t = makeTimer();
    const result = await t.time("a", async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 42;
    });
    expect(result).toBe(42);
    const spans = parse(t.header());
    expect(spans.map(([n]) => n)).toEqual(["a", "total"]);
    expect(spans[0][1]).toBeGreaterThanOrEqual(5);
    // total covers the whole timer lifetime, so it is >= the span it contains
    expect(spans[1][1]).toBeGreaterThanOrEqual(spans[0][1]);
  });

  it("times concurrent spans independently (each records its own elapsed)", async () => {
    const t = makeTimer();
    await Promise.all([
      t.time("slow", () => new Promise((r) => setTimeout(r, 30))),
      t.time("fast", () => new Promise((r) => setTimeout(r, 5))),
    ]);
    const byName = Object.fromEntries(parse(t.header()));
    // Each span reflects its own duration, not a delta since the previous mark
    expect(byName.fast).toBeLessThan(byName.slow);
    expect(byName.slow).toBeGreaterThanOrEqual(25);
  });

  it("records the span even when the wrapped fn throws", async () => {
    const t = makeTimer();
    await expect(
      t.time("boom", async () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(parse(t.header()).map(([n]) => n)).toContain("boom");
  });

  it("timeSync measures synchronous work and passes the return value through", () => {
    const t = makeTimer();
    const out = t.timeSync("sync", () => "value");
    expect(out).toBe("value");
    expect(parse(t.header()).map(([n]) => n)).toEqual(["sync", "total"]);
  });

  it("reproduces the middleware duration request header as the leading mw entry", () => {
    const request = new Request("http://x/api/data", {
      headers: { [MIDDLEWARE_DUR_HEADER]: "12.3" },
    });
    const t = makeTimer(request);
    const spans = parse(t.header());
    expect(spans[0]).toEqual(["mw", 12.3]);
  });

  it("ignores a malformed middleware duration header", () => {
    const request = new Request("http://x/api/data", {
      headers: { [MIDDLEWARE_DUR_HEADER]: "not-a-number" },
    });
    const t = makeTimer(request);
    expect(parse(t.header()).map(([n]) => n)).toEqual(["total"]);
  });

  it("allows duplicate span names (repeated work is signal, not an error)", async () => {
    const t = makeTimer();
    await t.time("clerk", async () => {});
    await t.time("clerk", async () => {});
    const names = parse(t.header()).map(([n]) => n);
    expect(names.filter((n) => n === "clerk")).toHaveLength(2);
  });
});

describe("serverTimingHeaders", () => {
  it("emits BOTH the standard header and the x-server-timing mirror with one identical value", () => {
    // The mirror exists because Vercel strips the reserved `Server-Timing` header on prod
    // (vercel/next.js#62353); `x-*` passes through so the benchmark can still read the phases.
    const t = makeTimer();
    const headers = serverTimingHeaders(t);
    expect(headers["Server-Timing"]).toBeDefined();
    expect(headers["x-server-timing"]).toBe(headers["Server-Timing"]);
    // The value is a well-formed Server-Timing string (here just the implicit `total`).
    expect(parse(headers["Server-Timing"]).map(([n]) => n)).toEqual(["total"]);
  });

  it("returns an empty object when the timer is absent (spread-safe)", () => {
    expect(serverTimingHeaders(undefined)).toEqual({});
  });
});

describe("forwardRequestHeader", () => {
  const OVERRIDE = "x-middleware-override-headers";
  const PREFIX = "x-middleware-request-";

  it("seeds the override list with ALL existing request headers when absent", () => {
    // Seeding with only the new name would strip cookies/auth from the forwarded request.
    const req = new Request("http://x/api/data", {
      headers: { cookie: "session=abc", "x-other": "1" },
    });
    const res = new Response(null);
    forwardRequestHeader(res, req, MIDDLEWARE_DUR_HEADER, "12.3");

    const override = res.headers.get(OVERRIDE)!.split(",");
    expect(override).toEqual(
      expect.arrayContaining(["cookie", "x-other", MIDDLEWARE_DUR_HEADER]),
    );
    expect(res.headers.get(`${PREFIX}cookie`)).toBe("session=abc");
    expect(res.headers.get(`${PREFIX}${MIDDLEWARE_DUR_HEADER}`)).toBe("12.3");
  });

  it("appends to an existing override list (composes with Clerk's own forwarding)", () => {
    const req = new Request("http://x/api/data", {
      headers: { cookie: "session=abc" },
    });
    const res = new Response(null);
    res.headers.set(OVERRIDE, "cookie,x-clerk-auth-status");
    res.headers.set(`${PREFIX}x-clerk-auth-status`, "signed-in");
    forwardRequestHeader(res, req, MIDDLEWARE_DUR_HEADER, "5.0");

    expect(res.headers.get(OVERRIDE)).toBe(
      `cookie,x-clerk-auth-status,${MIDDLEWARE_DUR_HEADER}`,
    );
    // Pre-existing forwarded headers are untouched
    expect(res.headers.get(`${PREFIX}x-clerk-auth-status`)).toBe("signed-in");
    expect(res.headers.get(`${PREFIX}${MIDDLEWARE_DUR_HEADER}`)).toBe("5.0");
  });

  it("overwrites a spoofed inbound copy of the forwarded header", () => {
    const req = new Request("http://x/api/data", {
      headers: { [MIDDLEWARE_DUR_HEADER]: "9999" },
    });
    const res = new Response(null);
    forwardRequestHeader(res, req, MIDDLEWARE_DUR_HEADER, "1.5");
    // The seeded copy of the spoofed value is replaced by ours (set, not append)
    expect(res.headers.get(`${PREFIX}${MIDDLEWARE_DUR_HEADER}`)).toBe("1.5");
  });
});
