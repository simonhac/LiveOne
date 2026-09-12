/**
 * Metrics must never be able to stop the usher collecting. The usher polls generators and
 * inverters; a misconfigured exporter costing a reading would be a far worse outcome than no
 * metrics at all. These tests pin that, and pin the endpoint rule that cost an hour to discover:
 * there is no shared Better Stack ingest URL, so a missing endpoint must disable metrics loudly
 * rather than fall back to a plausible-looking host that 401s every 60 seconds.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import os from "node:os";

import {
  initTelemetry,
  getMeter,
  shutdownTelemetry,
  __resetTelemetryForTests,
} from "../telemetry";
import { startRuntimeMetrics, __internals } from "../runtime-metrics";

const ENV_KEYS = [
  "BETTERSTACK_SOURCE_TOKEN",
  "BETTERSTACK_METRICS_ENDPOINT",
] as const;

let saved: Record<string, string | undefined> = {};

function collectLogs() {
  const lines: string[] = [];
  return { log: (m: string) => lines.push(m), lines };
}

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  __resetTelemetryForTests();
});

afterEach(async () => {
  await shutdownTelemetry();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("telemetry init", () => {
  it("is a no-op, not an error, with no token — a Pi or a laptop is a legitimate state", () => {
    const { log, lines } = collectLogs();

    expect(() => initTelemetry(log)).not.toThrow();
    expect(lines.join("\n")).toContain("disabled");
    expect(getMeter("runtime")).toBeDefined();
  });

  it("disables metrics — loudly, without throwing — when a token has no endpoint", () => {
    // THE POINT: there is no safe default endpoint. in-otel.logs.betterstack.com is region-pinned
    // and 401s for a source in another region, so guessing produces a source that looks configured
    // and ingests nothing. Refusing to start metrics is right; refusing to start the USHER is not.
    process.env.BETTERSTACK_SOURCE_TOKEN = "tok_abcdefghijklmnop";
    const { log, lines } = collectLogs();

    expect(() => initTelemetry(log)).not.toThrow();

    const out = lines.join("\n");
    expect(out).toContain("BETTERSTACK_METRICS_ENDPOINT");
    expect(out).toContain("DISABLED");
    // The message has to say what to do, or it is just noise at 3am.
    expect(out).toContain("ingesting_host");
  });

  it("reports the endpoint it will push to once both are set", () => {
    process.env.BETTERSTACK_SOURCE_TOKEN = "tok_abcdefghijklmnop";
    process.env.BETTERSTACK_METRICS_ENDPOINT =
      "https://s2754099.us-west-2a.betterstackdata.com/v1/metrics";
    const { log, lines } = collectLogs();

    initTelemetry(log);

    expect(lines.join("\n")).toContain(
      "s2754099.us-west-2a.betterstackdata.com",
    );
  });

  it("is idempotent — Next can call register() more than once", () => {
    const { log } = collectLogs();
    initTelemetry(log);
    const first = getMeter("runtime");
    initTelemetry(log);

    expect(getMeter("runtime")).toBe(first);
  });
});

describe("runtime metrics", () => {
  it("starts and stops without a token, and never throws", () => {
    const { log, lines } = collectLogs();

    let stop: (() => void) | undefined;
    expect(() => {
      stop = startRuntimeMetrics(log);
    }).not.toThrow();
    expect(lines.join("\n")).toContain("runtime metrics started");

    expect(() => stop!()).not.toThrow();
  });

  it("measures against the guest kernel's memory, not the Fly nameplate size", () => {
    // A 256 MB Fly machine reports MemTotal of 207 MB; a 512 MB one reports 459 MB. Using the
    // nameplate would understate real memory pressure by 10-19%.
    expect(__internals.MEM_TOTAL_MB).toBe(
      Math.round(os.totalmem() / (1024 * 1024)),
    );
  });

  it("reports CPU as a fraction of the guest's CPUs, not raw seconds", () => {
    // A ratio survives a `fly scale vm` with no retuning — the same reason mem_total_ratio is one.
    // It is also bounded, which an alert threshold depends on.
    const v = __internals.readCpuUtilization();
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(__internals.CPU_COUNT).toBeGreaterThanOrEqual(1);
  });

  it("reads event-loop utilization and active handles without throwing", () => {
    // Both are read from inside an observable callback; a throw there takes down the whole
    // collection cycle rather than one metric.
    expect(() => __internals.readEventLoopUtilization()).not.toThrow();
    const elu = __internals.readEventLoopUtilization();
    expect(elu).toBeGreaterThanOrEqual(0);
    expect(elu).toBeLessThanOrEqual(1);
    expect(__internals.readActiveHandles()).toBeGreaterThanOrEqual(0);
  });

  it("observes no GC series until a GC of that kind has actually run", () => {
    // An absent `major` series means none has run — which is not the same claim as "major pause
    // time is zero", and the chart should not be able to make the second one.
    for (const [kind, ms] of __internals.gcPauseMsByKind) {
      expect(typeof kind).toBe("string");
      expect(ms).toBeGreaterThan(0);
    }
  });

  it("does not throw reading the event-loop p99 before any samples exist", () => {
    // percentile() throws on an empty histogram, and a throwing observable callback takes down the
    // entire collection cycle rather than one metric.
    expect(() => __internals.readEventLoopP99Ms()).not.toThrow();
    expect(typeof __internals.readEventLoopP99Ms()).toBe("number");
  });
});
