import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
  jest,
} from "@jest/globals";

import { withQstashSignatureVerification } from "../qstash-receiver";

/**
 * The receiver's signature gate — specifically the half-configured case.
 *
 * From SDK 2.11 `getReceiverSigningKeys` accepts the config pair only when BOTH keys are set; with
 * just the current one it silently falls through to the bare `QSTASH_*` env vars and then throws on
 * every delivered message. Under 2.8.4 the same state threw at module load. Neither is a working
 * receiver, so the wrapper must refuse it up front — that is the property pinned here, and it is
 * exactly what a future SDK bump could regress without any type error.
 */

const CURRENT = "OBSERVATIONS_QSTASH_CURRENT_SIGNING_KEY";
const NEXT = "OBSERVATIONS_QSTASH_NEXT_SIGNING_KEY";

const saved = { current: process.env[CURRENT], next: process.env[NEXT] };

function setKeys(current: string | undefined, next: string | undefined) {
  if (current === undefined) delete process.env[CURRENT];
  else process.env[CURRENT] = current;
  if (next === undefined) delete process.env[NEXT];
  else process.env[NEXT] = next;
}

/** The wrapper warns on every disabled path; keep the suite output clean. */
beforeEach(() => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(() => {
  setKeys(saved.current, saved.next);
});

const ok = async () => new Response("ok");

describe("withQstashSignatureVerification", () => {
  it.each([
    ["neither key", undefined, undefined],
    ["current only", "current-key", undefined],
    ["next only", undefined, "next-key"],
  ])("disables the receiver with %s", async (_label, current, next) => {
    setKeys(current, next);

    const handler = withQstashSignatureVerification(ok);
    const response = await handler(new Request("https://example.test/receive"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "error",
      error: "QStash receiver not configured",
    });
  });

  it("rejects an unsigned request when both keys are configured", async () => {
    setKeys("current-key", "next-key");

    const handler = withQstashSignatureVerification(ok);
    const response = await handler(new Request("https://example.test/receive"));

    // 403, not 503: the SDK's verifier is in the path and refused a request with no
    // `Upstash-Signature` header. Never 200 — an unverified body must not reach the handler.
    expect(response.status).toBe(403);
  });
});
