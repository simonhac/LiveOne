/**
 * Process-level metrics for the usher hub. Exported via OTel (see telemetry.ts) and logged every
 * five minutes.
 *
 * Metric names match clara's bot/src/lib/runtime-metrics.ts and mrtippy's memory-metrics.ts so a
 * single Better Stack dashboard shape serves all three Fly apps.
 *
 * Before this existed, liveone-flyhub reported nothing at all. Fly's own fly_instance_* covers
 * CPU and whole-VM memory for free, but it retains ~11 days, cannot see the heap, and cannot tell
 * you whether THIS process is starved of CPU — only whether the host is busy.
 */

import os from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { getMeter } from "./telemetry";

const MB = 1024 * 1024;
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * What the guest kernel reports, NOT the Fly machine size — they are not the same and the
 * difference is not a rounding error. Measured off fly_instance_memory_mem_total on 2026-09-12:
 * a 256 MB machine reports 207 MB, a 512 MB machine 459 MB, a 1024 MB machine 962 MB. A ratio
 * computed against the nameplate size understates real pressure by roughly 10-19%.
 */
const MEM_TOTAL_BYTES = os.totalmem();
const MEM_TOTAL_MB = Math.round(MEM_TOTAL_BYTES / MB);

/**
 * Attached to every observation. Better Stack does NOT surface OTel *resource* attributes as
 * queryable labels — verified against mrtippy's source on 2026-09-12, where process.memory.* shows
 * `Tags: none` despite service.name being set. Observation attributes do survive.
 */
const ATTRS = { service: "liveone-usher" } as const;

// Event-loop delay. Reset on each read so each exported p99 describes the interval just ended;
// left cumulative it flattens into uselessness within a day.
const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
let lastEventLoopP99Ms = 0;

function readEventLoopP99Ms(): number {
  // percentile() throws on an empty histogram, and a throwing observable callback takes down the
  // whole collection cycle, not just this one metric.
  if (eventLoopDelay.count === 0) return lastEventLoopP99Ms;
  lastEventLoopP99Ms = eventLoopDelay.percentile(99) / 1e6; // ns → ms
  eventLoopDelay.reset();
  return lastEventLoopP99Ms;
}

const LOG_INTERVAL_MS = 5 * 60_000;

/**
 * Register the gauges and start the periodic log line. Returns a stop function.
 * Safe to call once per process; `startUsher` does it from instrumentation.ts.
 */
export function startRuntimeMetrics(
  log: (m: string) => void = console.log,
): () => void {
  const meter = getMeter("runtime");

  const gauge = (name: string, description: string, read: () => number) =>
    meter
      .createObservableGauge(name, { description })
      .addCallback((obs) => obs.observe(read(), ATTRS));

  gauge(
    "process.memory.rss",
    "Resident set size in bytes",
    () => process.memoryUsage().rss,
  );
  gauge(
    "process.memory.heap_used",
    "V8 heap used in bytes",
    () => process.memoryUsage().heapUsed,
  );
  gauge(
    "process.memory.heap_total",
    "V8 heap total in bytes",
    () => process.memoryUsage().heapTotal,
  );
  gauge(
    "process.memory.external",
    "Memory used by C++ objects bound to JS objects, in bytes",
    () => process.memoryUsage().external,
  );
  gauge(
    "process.memory.array_buffers",
    "Memory allocated for ArrayBuffer and SharedArrayBuffer instances, in bytes",
    () => process.memoryUsage().arrayBuffers,
  );
  gauge(
    "process.memory.mem_total_ratio",
    "RSS as a fraction of the memory the guest kernel reports",
    () => process.memoryUsage().rss / MEM_TOTAL_BYTES,
  );
  gauge("process.uptime", "Seconds since this process started", () =>
    process.uptime(),
  );
  gauge(
    "nodejs.eventloop.delay_p99",
    "99th percentile event loop delay in milliseconds",
    readEventLoopP99Ms,
  );

  eventLoopDelay.enable();

  const timer = setInterval(() => {
    const mem = process.memoryUsage();
    log(
      `usher: rss=${round1(mem.rss / MB)}MB heap=${round1(mem.heapUsed / MB)}MB ` +
        `of memTotal=${MEM_TOTAL_MB}MB (${round1((mem.rss / MEM_TOTAL_BYTES) * 100)}%) ` +
        `eventLoopP99=${round1(lastEventLoopP99Ms)}ms uptime=${round1(process.uptime() / 3600)}h`,
    );
  }, LOG_INTERVAL_MS);
  timer.unref();

  log(`usher: runtime metrics started (memTotal=${MEM_TOTAL_MB}MB)`);

  return () => {
    clearInterval(timer);
    eventLoopDelay.disable();
  };
}

/** Test seam. */
export const __internals = { readEventLoopP99Ms, MEM_TOTAL_MB };
