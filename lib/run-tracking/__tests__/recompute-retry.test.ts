import { describe, expect, it, jest } from "@jest/globals";
import {
  isTransientPostgresError,
  withTransientPostgresRetry,
} from "@/lib/db/planetscale/transient-retry";

describe("run-period database retry", () => {
  it.each([
    Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    Object.assign(new Error("server restart"), { code: "57P01" }),
    Object.assign(new Error("protocol connection exception"), {
      code: "08006",
    }),
    new Error("Connection terminated unexpectedly"),
    new Error("Client has encountered a connection error"),
  ])("recognizes transient connection failures", (error) => {
    expect(isTransientPostgresError(error)).toBe(true);
  });

  it("does not retry ordinary query or domain failures", async () => {
    const operation = jest
      .fn<() => Promise<never>>()
      .mockRejectedValue(
        Object.assign(new Error("duplicate key"), { code: "23505" }),
      );
    await expect(
      withTransientPostgresRetry(operation, {
        maxAttempts: 3,
        sleep: async () => {},
      }),
    ).rejects.toThrow("duplicate key");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("retries the complete operation with bounded backoff", async () => {
    const operation = jest
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("Connection terminated unexpectedly"))
      .mockRejectedValueOnce(
        Object.assign(new Error("reset"), { code: "ECONNRESET" }),
      )
      .mockResolvedValue("ok");
    const delays: number[] = [];
    const onRetry = jest.fn();

    await expect(
      withTransientPostgresRetry(
        operation,
        {
          maxAttempts: 3,
          retryDelayMs: 500,
          sleep: async (delayMs) => {
            delays.push(delayMs);
          },
        },
        onRetry,
      ),
    ).resolves.toBe("ok");

    expect(operation).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([500, 1000]);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("surfaces a connection failure after the retry budget", async () => {
    const operation = jest
      .fn<() => Promise<never>>()
      .mockRejectedValue(new Error("Connection terminated unexpectedly"));

    await expect(
      withTransientPostgresRetry(
        operation,
        {
          maxAttempts: 2,
          retryDelayMs: 0,
          sleep: async () => {},
        },
        jest.fn(),
      ),
    ).rejects.toThrow("Connection terminated unexpectedly");
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
