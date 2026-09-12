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
 *
 * 🛑 THIS FILE IS THE RUNTIME TIER: it may depend on nothing but `os`, `process` and `perf_hooks`.
 * That is the entire reason it is portable to clara and mrtippy. The moment a metric here needs a
 * handle on something this app owns — the spool, a query client, a pool — it stops being
 * copy-pasteable and the other two apps have to stub it or fork it. App-specific metrics go in
 * their own file; for the usher that is spool-metrics.ts.
 */

import os from "node:os";
import {
  constants as perfConstants,
  monitorEventLoopDelay,
  performance,
  PerformanceObserver,
} from "node:perf_hooks";
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

// ── The 2026-09-12 additions: CPU, event-loop saturation, GC and handles ─────────────────────────
//
// The original eight were all memory, uptime and one latency percentile. Between them they cannot
// answer four questions that have each cost an investigation somewhere in this fleet:
//
//   "is this process CPU-starved?"       → process.cpu.utilization
//   "is the event loop saturated?"       → nodejs.eventloop.utilization  (delay_p99 sees SPIKES; a
//                                          steadily pegged loop can sit at a low p99)
//   "is it leaking, or just collecting?" → nodejs.gc.pause  (heap_used sawtooths either way)
//   "is it leaking a socket or fd?"      → process.handles  (reads as flat RSS, then a hard failure)
//
// All four are pure runtime, so they belong in this tier and are byte-portable to the other apps.

/**
 * Fraction of the CPU available to the guest that THIS process used since the last observation.
 *
 * A ratio, not seconds, for the same reason mem_total_ratio is one: it survives a `fly scale vm`
 * with no retuning. Divided by the CPU count the guest reports — on shared-cpu-1x that is 1, so a
 * sustained value near 1.0 means this process is using its whole share, NOT that the host is busy.
 * That distinction is exactly what fly_instance_cpu cannot make.
 */
const CPU_COUNT = Math.max(1, os.cpus().length);
let lastCpuUsage = process.cpuUsage();
let lastCpuAtNs = process.hrtime.bigint();

function readCpuUtilization(): number {
  const nowNs = process.hrtime.bigint();
  const elapsedUs = Number(nowNs - lastCpuAtNs) / 1e3;
  // cpuUsage(previous) returns the delta since `previous`, in microseconds.
  const delta = process.cpuUsage(lastCpuUsage);
  lastCpuUsage = process.cpuUsage();
  lastCpuAtNs = nowNs;
  if (elapsedUs <= 0) return 0;
  return (delta.user + delta.system) / elapsedUs / CPU_COUNT;
}

/**
 * Event-loop utilization: the fraction of the interval the loop was ACTIVE rather than idle.
 *
 * Complementary to delay_p99, not a replacement. A loop pegged by a steady stream of short tasks
 * shows a low p99 and a utilization near 1.0; one blocked by a single long task shows the reverse.
 * Read as a delta so each export describes the interval just ended, same discipline as the p99.
 */
let lastElu = performance.eventLoopUtilization();

function readEventLoopUtilization(): number {
  const delta = performance.eventLoopUtilization(lastElu);
  lastElu = performance.eventLoopUtilization();
  // utilization is idle/(idle+active) and is NaN when NEITHER moved — a genuinely idle process
  // observed twice inside the same millisecond. Observing NaN would poison the series, so an idle
  // loop reports the truth: 0% utilized.
  return Number.isFinite(delta.utilization) ? delta.utilization : 0;
}

/**
 * Cumulative GC pause time in milliseconds, split by kind.
 *
 * A COUNTER, deliberately not a histogram: Better Stack stores histograms in bucket_* columns read
 * via histogramQuantile(), and this fleet is gauges-and-counters throughout so a single read path
 * serves every chart and the parity checker. mrtippy made the same call for slack.throttle.wait.
 *
 * `major` is the load-bearing series. A busy-but-healthy process drives `minor` and leaves `major`
 * close to flat; a leak drives `major` up as the old space refuses to shrink. That is what tells a
 * leak apart from ordinary work on an RSS chart that sawtooths identically in both cases — the
 * exact ambiguity the 2026-04 mrtippy OOM investigation ran into.
 */
const GC_KIND_NAMES: Record<number, string> = {
  [perfConstants.NODE_PERFORMANCE_GC_MINOR]: "minor",
  [perfConstants.NODE_PERFORMANCE_GC_MAJOR]: "major",
  [perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL]: "incremental",
  [perfConstants.NODE_PERFORMANCE_GC_WEAKCB]: "weakcb",
};

const gcPauseMsByKind = new Map<string, number>();

const gcObserver = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    const detail = (entry as { detail?: { kind?: number } }).detail;
    const kind = GC_KIND_NAMES[detail?.kind ?? -1] ?? "other";
    gcPauseMsByKind.set(
      kind,
      (gcPauseMsByKind.get(kind) ?? 0) + entry.duration,
    );
  }
});

/**
 * Active libuv resources — timers, sockets, file handles, child processes — keeping the loop alive.
 *
 * `getActiveResourcesInfo()` is the documented API (Node >= 16.14). `process._getActiveHandles()`
 * is what every blog post reaches for and is undocumented and internal. A socket or fd leak is
 * invisible on every other metric in this file: RSS stays flat, the heap stays flat, and then the
 * process hits EMFILE and dies. Monotonic growth here across a restart-free window is the signal.
 */
function readActiveHandles(): number {
  return process.getActiveResourcesInfo().length;
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
  gauge(
    "process.cpu.utilization",
    "CPU used by this process since the last observation, as a fraction of the guest's CPUs",
    readCpuUtilization,
  );
  gauge(
    "nodejs.eventloop.utilization",
    "Fraction of the interval the event loop was active rather than idle",
    readEventLoopUtilization,
  );
  gauge(
    "process.handles",
    "Active libuv handles and requests keeping the event loop alive",
    readActiveHandles,
  );

  meter
    .createObservableCounter("nodejs.gc.pause", {
      description: "Cumulative garbage-collection pause time",
      // The unit lives HERE, not in the name. Semantic conventions are explicit that a metric name
      // should exclude a unit already carried by the instrument metadata — the same call mrtippy
      // made turning slack.api.throttle_wait_ms into slack.throttle.wait.
      unit: "ms",
    })
    .addCallback((obs) => {
      // No GC of a given kind yet → no series for it. That is the honest shape: an absent `major`
      // series means none has run, which is not the same claim as "major pause time is zero".
      for (const [kind, ms] of gcPauseMsByKind) {
        obs.observe(ms, { ...ATTRS, kind });
      }
    });

  eventLoopDelay.enable();
  gcObserver.observe({ entryTypes: ["gc"] });

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
    gcObserver.disconnect();
  };
}

/** Test seam. */
export const __internals = {
  readEventLoopP99Ms,
  readCpuUtilization,
  readEventLoopUtilization,
  readActiveHandles,
  gcPauseMsByKind,
  MEM_TOTAL_MB,
  CPU_COUNT,
};
