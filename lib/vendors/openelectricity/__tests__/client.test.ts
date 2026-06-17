import { describe, it, expect, afterEach, jest } from "@jest/globals";
import {
  OpenElectricityApiError,
  fetchMarketData,
  fetchNetworkData,
  type FetchNetworkArgs,
} from "../client";

/** Build a minimal fetch Response stand-in for the client (status/ok/headers/text/json). */
function fakeResponse(opts: { status: number; body: string }): Response {
  return {
    status: opts.status,
    ok: opts.status >= 200 && opts.status < 300,
    headers: { get: () => null },
    text: async () => opts.body,
    json: async () => JSON.parse(opts.body),
  } as unknown as Response;
}

const baseArgs: FetchNetworkArgs = {
  region: "NSW1",
  metrics: ["price"],
  dateStart: new Date("2026-06-17T11:00:00Z"),
  dateEnd: new Date("2026-06-17T11:20:00Z"),
  apiKey: "test-key",
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe("fetchSeries leading-edge 404 handling", () => {
  it("treats a 404 'in the specified time range' as an empty result (market)", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      fakeResponse({
        status: 404,
        body: '{"version":"4.5.4","response_status":"ERROR","error":"No market data available for network NEM in the specified time range","success":false}',
      }),
    );

    const { response } = await fetchMarketData({
      ...baseArgs,
      metrics: ["price", "renewable_proportion"],
    });
    expect(response.success).toBe(true);
    expect(response.data).toEqual([]);
    expect(response.total_records).toBe(0);
  });

  it("treats a 404 'in the specified time range' as empty for the data endpoint too", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      fakeResponse({
        status: 404,
        body: '{"error":"No data available for network NEM in the specified time range","success":false}',
      }),
    );

    const { response } = await fetchNetworkData({
      ...baseArgs,
      metrics: ["power", "emissions"],
    });
    expect(response.data).toEqual([]);
  });

  it("still throws on a 404 that is NOT a no-data-for-window error", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(
        fakeResponse({ status: 404, body: '{"error":"Unknown metric"}' }),
      );

    await expect(fetchMarketData(baseArgs)).rejects.toBeInstanceOf(
      OpenElectricityApiError,
    );
  });

  it("still throws on a 5xx (retryable)", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(
        fakeResponse({ status: 503, body: "upstream unavailable" }),
      );

    await expect(fetchMarketData(baseArgs)).rejects.toMatchObject({
      status: 503,
      retryable: true,
    });
  });
});
