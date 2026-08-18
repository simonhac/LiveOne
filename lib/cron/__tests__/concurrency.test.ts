/**
 * The worker pool and deadline that bound the minutely poll loop. These guard the two properties
 * the measured failure depended on: that no more than N devices run at once, and that one slow
 * device stops costing the others their share of the 60 s budget.
 */
import { describe, expect, it } from "@jest/globals";
import {
  DeadlineExceededError,
  mapWithConcurrency,
  withDeadline,
} from "../concurrency";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mapWithConcurrency", () => {
  it("returns results in INPUT order, not completion order", async () => {
    const out = await mapWithConcurrency([30, 5, 20, 1], 4, async (ms, i) => {
      await sleep(ms);
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3]);
  });

  it("never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 12 }), 4, async () => {
      peak = Math.max(peak, ++inFlight);
      await sleep(5);
      inFlight--;
    });
    expect(peak).toBe(4);
  });

  it("uses fewer workers than the limit when there is less work", async () => {
    let peak = 0;
    let inFlight = 0;
    await mapWithConcurrency([1, 2], 8, async () => {
      peak = Math.max(peak, ++inFlight);
      await sleep(5);
      inFlight--;
    });
    expect(peak).toBe(2);
  });

  it("handles an empty list without hanging", async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });

  /**
   * The isolation property, stated as a timing claim: 4 items of 40 ms each with 4 workers finish
   * in ~40 ms, not ~160 ms. Sequentially, one slow vendor spent everybody's budget.
   */
  it("runs concurrently rather than serially", async () => {
    const started = Date.now();
    await mapWithConcurrency([40, 40, 40, 40], 4, async (ms) => sleep(ms));
    expect(Date.now() - started).toBeLessThan(120);
  });
});

describe("withDeadline", () => {
  it("passes a value through when it settles in time", async () => {
    await expect(withDeadline(Promise.resolve("ok"), 1000)).resolves.toBe("ok");
  });

  it("rejects with DeadlineExceededError when it does not", async () => {
    await expect(withDeadline(sleep(200), 20)).rejects.toBeInstanceOf(
      DeadlineExceededError,
    );
  });

  it("names the budget in the message so a timeout is legible in the logs", () => {
    expect(new DeadlineExceededError(15_000).message).toBe(
      "exceeded its 15s poll deadline",
    );
  });

  it("propagates the original rejection, not a timeout", async () => {
    await expect(
      withDeadline(Promise.reject(new Error("vendor 502")), 1000),
    ).rejects.toThrow("vendor 502");
  });

  it("treats a non-positive deadline as no deadline", async () => {
    await expect(withDeadline(Promise.resolve(7), 0)).resolves.toBe(7);
  });

  /** A deadline that stayed armed would keep the Lambda alive past the work it was bounding. */
  it("clears its timer on success", async () => {
    const before = process.listenerCount("unhandledRejection");
    await withDeadline(sleep(5), 5000);
    expect(process.listenerCount("unhandledRejection")).toBe(before);
  });
});
