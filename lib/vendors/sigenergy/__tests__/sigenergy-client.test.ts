import { describe, it, expect, jest, afterEach } from "@jest/globals";
import {
  pickNumberPreferNonZero,
  parseEnergyFlow,
  SigenergyClient,
  LIVE_POLL_TIMEOUT_MS,
  AUTH_TIMEOUT_MS,
  BACKFILL_TIMEOUT_MS,
} from "../sigenergy-client";
import { SigenergyAdapter } from "../adapter";

describe("pickNumberPreferNonZero", () => {
  // The live failure: an AC-charger site reports `evPower: 0` (the DC field) alongside the real
  // `acPower`, so plain first-key-wins reported 0 EV charging for every such site.
  it("skips a present-but-zero earlier key in favour of a later non-zero one", () => {
    expect(
      pickNumberPreferNonZero({ evPower: 0, acPower: 6.66 }, [
        "evPower",
        "acPower",
      ]),
    ).toBe(6.66);
  });

  it("keeps the first key when it is non-zero", () => {
    expect(
      pickNumberPreferNonZero({ evPower: 3.2, acPower: 6.66 }, [
        "evPower",
        "acPower",
      ]),
    ).toBe(3.2);
  });

  it("returns 0 when every candidate is genuinely zero (idle, not missing)", () => {
    expect(
      pickNumberPreferNonZero({ evPower: 0, acPower: 0 }, [
        "evPower",
        "acPower",
      ]),
    ).toBe(0);
  });

  it("returns null when no candidate is present", () => {
    expect(pickNumberPreferNonZero({ other: 1 }, ["evPower", "acPower"])).toBe(
      null,
    );
  });

  it("ignores absent keys and negative values are preserved", () => {
    expect(
      pickNumberPreferNonZero({ acPower: -2.5 }, ["evPower", "acPower"]),
    ).toBe(-2.5);
  });
});

/**
 * `pickNumber` is module-private, so it is exercised through the two extractors that use it. The
 * hazard is silent COERCION: bare `Number()` turns `false`, `[]` and `" "` into `0`, which is
 * indistinguishable downstream from the site genuinely producing nothing. The live payload really
 * does carry a boolean (`onGrid`) and an array (`greenSourceInfos`) beside the numeric fields, and
 * the keys are candidate LISTS spanning vendor spellings — so a rename landing on the wrong type is
 * the realistic way this bites.
 */
describe("pickNumber (via parseEnergyFlow) — coercion hazards", () => {
  const flow = (over: Record<string, unknown>) =>
    parseEnergyFlow({ data: { pvPower: 1.5, ...over } });

  it("reads a plain number", () => {
    expect(flow({}).pvKw).toBe(1.5);
  });

  it("treats a boolean as absent, not as 0/1", () => {
    expect(flow({ pvPower: false }).pvKw).toBeNull();
    expect(flow({ pvPower: true }).pvKw).toBeNull();
  });

  it("treats an array as absent, however numeric-looking", () => {
    expect(flow({ pvPower: [] }).pvKw).toBeNull();
    expect(flow({ pvPower: [7] }).pvKw).toBeNull();
  });

  it("treats an object as absent", () => {
    expect(flow({ pvPower: {} }).pvKw).toBeNull();
  });

  it("treats whitespace as absence, not zero", () => {
    expect(flow({ pvPower: "  " }).pvKw).toBeNull();
    expect(flow({ pvPower: "" }).pvKw).toBeNull();
  });

  it("rejects a non-finite reading", () => {
    expect(flow({ pvPower: "Infinity" }).pvKw).toBeNull();
    expect(flow({ pvPower: Number.NaN }).pvKw).toBeNull();
  });

  it("still accepts a numeric string, and a genuine zero", () => {
    // Insurance against a vendor that starts quoting its numbers; none does today.
    expect(flow({ pvPower: "2.25" }).pvKw).toBe(2.25);
    expect(flow({ pvPower: 0 }).pvKw).toBe(0);
    expect(flow({ pvPower: "0" }).pvKw).toBe(0);
  });

  it("falls through a bad candidate to a later good one", () => {
    // The realistic shape: the first spelling exists but carries the wrong type.
    expect(
      parseEnergyFlow({ data: { pvPower: false, solarPower: 3.5 } }).pvKw,
    ).toBe(3.5);
  });
});

/**
 * The request budget. These are not taste: the ORDER of the two numbers is the whole design, and
 * the vendor's ~49-55 s give-up is what makes a socket timeout worth having at all.
 */
describe("request budget invariants", () => {
  it("dies before the worker deadline, so a hang can never outlive its tick", () => {
    // `withDeadline` frees the worker, not the socket. If the deadline fires first the request
    // keeps running unsupervised — prod has a session recorded at 237 s. Both request budgets on
    // the poll path must therefore land strictly inside it.
    const deadline = new SigenergyAdapter().pollDeadlineMs;
    expect(LIVE_POLL_TIMEOUT_MS).toBeLessThan(deadline);
    expect(AUTH_TIMEOUT_MS).toBeLessThan(deadline);
  });

  it("cuts the live poll below the vendor's own give-up, and the backfill above it", () => {
    // Measured on prod: failures cluster at ~54.8 s and late successes at ~49.2 s, i.e. Sigenergy
    // answers a bad gateway at ~49-55 s. Below that band we stop waiting; above it we let a
    // request that WILL be answered finish. The live poll has a minutely retry behind it and the
    // nightly backfill has nothing, which is why they sit on opposite sides.
    expect(LIVE_POLL_TIMEOUT_MS).toBeLessThan(49_000);
    expect(BACKFILL_TIMEOUT_MS).toBeGreaterThan(55_000);
  });
});

describe("apiGet — per-call-site retry budget", () => {
  const TOKEN = JSON.stringify({
    code: 0,
    data: { access_token: "t", expires_in: 3600 },
  });
  const res = (status: number, body: string) =>
    ({ ok: status < 400, status, text: async () => body }) as Response;
  const client = () =>
    new SigenergyClient({ username: "u", password: "p", region: "aus" });

  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  /** Login answers once, then every data request behaves as `then` says. */
  const mock = (then: () => Promise<Response>) => {
    const urls: string[] = [];
    global.fetch = jest.fn(async (url: unknown) => {
      urls.push(String(url));
      return urls.length === 1 ? res(200, TOKEN) : then();
    }) as unknown as typeof fetch;
    return urls;
  };

  it("does not retry the live poll — the minutely cron is the retry", async () => {
    const urls = mock(() => {
      const e = new Error("timed out");
      e.name = "TimeoutError";
      return Promise.reject(e);
    });
    await expect(client().getEnergyFlow("station-1")).rejects.toMatchObject({
      kind: "timeout",
    });
    // Login + exactly ONE data attempt. Three would triple one bad poll into three vendor
    // timeouts, for a window the next tick re-attempts 60 s later anyway.
    expect(urls).toHaveLength(2);
  });

  it("keeps the ladder off the live path, where nothing else would retry", async () => {
    const urls = mock(async () => res(500, "{}"));
    await expect(client().getStation()).rejects.toMatchObject({ kind: "http" });
    expect(urls).toHaveLength(4); // login + 3 attempts
  });
});
