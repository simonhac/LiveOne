/**
 * What the hub client says when the thing that answered was not the hub — Cloudflare's edge.
 */
import { describe, it, expect, afterEach, jest } from "@jest/globals";

import { hubProbe } from "../hub-client";

const realFetch = global.fetch;

function answer(
  status: number,
  body: string,
  headers: Record<string, string> = {},
) {
  global.fetch = jest.fn(
    async () => new Response(body, { status, headers }),
  ) as typeof fetch;
}

afterEach(() => {
  global.fetch = realFetch;
});

describe("hub-client non-JSON responses", () => {
  it("names a 530 as the hub's tunnel being down, not as a parse failure", async () => {
    answer(530, "<html><title>Cloudflare Tunnel error</title></html>", {
      "cf-ray": "abc",
    });
    await expect(hubProbe("sheephouse", "pk")).rejects.toThrow(
      /hub is offline — its Cloudflare tunnel is not connected \(HTTP 530\)/,
    );
  });

  it("treats a cf-ray 52x as the edge failing to reach the hub", async () => {
    answer(522, "<html></html>", { "cf-ray": "abc" });
    await expect(hubProbe("sheephouse", "pk")).rejects.toThrow(/HTTP 522/);
  });

  it("quotes the page title for any other non-JSON body", async () => {
    answer(502, "<html><head><title>Bad gateway</title></head></html>");
    await expect(hubProbe("sheephouse", "pk")).rejects.toThrow(
      "The generator hub returned a non-JSON 502 response (“Bad gateway”)",
    );
  });
});
