/**
 * Session reuse for select.live.
 *
 * The bug these pin: the previous cache stored the string "authenticated" rather than the cookie,
 * and `fetchData` built a fresh client every poll — so the client's own `cookies.size === 0` guard
 * logged in again on every single poll. On prod that was 57 logins for 57 fetches, 49 of them on
 * polls where the cache had "hit". The assertions below are therefore about CALL COUNTS, not
 * return values: a cache that reports a hit while still authenticating is the exact failure.
 */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";

jest.mock("../selectronic-client", () => {
  const mockInstances: any[] = [];
  class MockClient {
    static authSucceeds = true;
    static fetchResult: any = {
      success: true,
      data: { timestamp: new Date(), solarW: 100 },
    };
    /** Epoch ms of the last successful auth; tests backdate it to age a session. */
    authedAt: number | null = null;
    authenticate = jest.fn(async () => {
      if (!MockClient.authSucceeds) return false;
      this.authedAt = Date.now();
      return true;
    });
    fetchData = jest.fn(async () => MockClient.fetchResult);
    sessionAgeMs() {
      return this.authedAt === null ? null : Date.now() - this.authedAt;
    }
    constructor() {
      mockInstances.push(this);
    }
  }
  return { SelectronicFetchClient: MockClient, __instances: mockInstances };
});

import { SelectronicAdapter, SELECTRONIC_SESSION_TTL_MS } from "../adapter";

const mocked = jest.requireMock("../selectronic-client") as any;
const MockClient = mocked.SelectronicFetchClient;
const instances: any[] = mocked.__instances;

const device = { id: 1, vendorSiteId: "1586" } as any;
const credentials = { email: "a@b.c", password: "pw" } as any;
const poll = () =>
  (new SelectronicAdapter() as any).fetchData(device, credentials, {} as any);

beforeEach(() => {
  instances.length = 0;
  MockClient.authSucceeds = true;
  MockClient.fetchResult = {
    success: true,
    data: { timestamp: new Date(), solarW: 100 },
  };
  (SelectronicAdapter as any).clientCache.clear();
});

describe("SelectronicAdapter — session reuse", () => {
  it("logs in once and then reuses the session across polls", async () => {
    for (let i = 0; i < 5; i++) expect((await poll()).success).toBe(true);

    // One client, one login, five fetches — not five logins.
    expect(instances).toHaveLength(1);
    expect(instances[0].authenticate).toHaveBeenCalledTimes(1);
    expect(instances[0].fetchData).toHaveBeenCalledTimes(5);
  });

  it("re-authenticates once the session passes its TTL", async () => {
    await poll();
    // Age the session past the TTL without touching the clock.
    instances[0].authedAt = Date.now() - SELECTRONIC_SESSION_TTL_MS - 1;
    await poll();

    expect(instances).toHaveLength(2);
    expect(instances[1].authenticate).toHaveBeenCalledTimes(1);
  });

  it("evicts a session the portal rejected, so the next poll logs in afresh", async () => {
    await poll();
    MockClient.fetchResult = {
      success: false,
      error: "Authentication failed",
      errorKind: "auth",
    };
    expect((await poll()).success).toBe(false);

    MockClient.fetchResult = {
      success: true,
      data: { timestamp: new Date(), solarW: 100 },
    };
    await poll();
    expect(instances).toHaveLength(2); // the rejected client was not reused
  });

  it("keeps the session through an upstream failure that says nothing about it", async () => {
    // 75% of select.live failures are HTTP 504 in its 00:00-00:20 rollover. Throwing the cookie
    // away on those would put us straight back to logging in on most polls.
    await poll();
    MockClient.fetchResult = {
      success: false,
      error: "HTTP 504: Gateway Timeout",
      errorCode: "504",
    };
    await poll();

    MockClient.fetchResult = {
      success: true,
      data: { timestamp: new Date(), solarW: 100 },
    };
    await poll();
    expect(instances).toHaveLength(1);
    expect(instances[0].authenticate).toHaveBeenCalledTimes(1);
  });

  it("does not cache a client whose login failed", async () => {
    MockClient.authSucceeds = false;
    const result = await poll();
    expect(result).toMatchObject({ success: false, errorKind: "auth" });

    MockClient.authSucceeds = true;
    await poll();
    expect(instances).toHaveLength(2);
  });
});
