/**
 * The delivery-option contract.
 *
 * `observationDeliveryOptions()` IS the fix for the 2026-09-09 head-of-line outage: with `timeout`
 * unset, QStash's per-attempt ceiling is the plan maximum (2h on pay-as-you-go), and the default
 * retry backoff (~12s / 148s / 1808s) is what held the FIFO lane for the observed 34 minutes per
 * message. So these assertions are deliberately exact rather than a snapshot — a publish site that
 * forgets one of the three options must fail loudly here.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FakeQstash } from "./fake-qstash";
import type { RawObservationInput } from "../publisher";
import type { Session } from "../types";
import type { DeviceConfigView } from "@/lib/registry/device-config";

const RECEIVER_URL = "https://example.test/api/observations/receive";

// A single fake client, created inside the mock factory and reused. It must be a PLAIN property
// on the mocked module, not a getter: the import interop reads every export once at module-eval
// time, which flattens a getter to whatever it returned then (null).
jest.mock("@/lib/db/planetscale", () => ({ planetscaleDb: null }));
jest.mock("@/lib/db/planetscale/schema", () => ({ observationsOutbox: {} }));
jest.mock("@/lib/qstash", () => {
  const actual = jest.requireActual("@/lib/qstash") as Record<string, unknown>;
  const { createFakeQstash } = jest.requireActual(
    "./fake-qstash",
  ) as typeof import("./fake-qstash");
  const instance = createFakeQstash();
  (globalThis as unknown as { __fakeQstash: FakeQstash }).__fakeQstash =
    instance;
  return {
    // Keep the REAL key scheme, so the assertions below pin the keys actually published.
    ...actual,
    getObservationsReceiverUrl: () =>
      "https://example.test/api/observations/receive",
    qstash: instance.client,
  };
});

/** Resolved lazily: the mock factory runs when `@/lib/qstash` is first required, not before. */
const fake = (): FakeQstash =>
  (globalThis as unknown as { __fakeQstash: FakeQstash }).__fakeQstash;

import {
  observationDeliveryOptions,
  laneParallelism,
  messageLane,
  publishMode,
  publishObservationMessage,
} from "../publish";
import {
  observationsFlowKey,
  OBSERVATIONS_FLOW_PREFIX,
  parseObservationsFlowKey,
  FLOW_KEY_CHARSET,
} from "@/lib/qstash";
import type { QueueMessage } from "../types";
import { publishPoll, createPollCollector } from "../poll-collector";
import { publishObservationBatch } from "../publisher";

const device = {
  id: 7,
  displayName: "Test System",
  vendorType: "select.live",
  vendorSiteId: "SITE-123",
  timezoneOffsetMin: 600,
} as unknown as DeviceConfigView;

const session: Session = {
  sessionId: "0192f000-0000-7000-8000-000000000001",
  sessionLabel: "test-label",
  cause: "CRON",
  started: "2025-01-15T20:30:00+10:00",
  durationMs: 1234,
  successful: true,
  errorCode: null,
  error: null,
  response: null,
  numRows: 0,
  startTime: "2025-01-15T20:30:00+10:00",
};

function makeInput(index: number, value: number): RawObservationInput {
  return {
    sessionId: session.sessionId,
    point: {
      metricType: "power",
      metricUnit: "W",
      pointId: `point-${index}`,
      pointUid: `pt_test${index}`,
      physicalPathTail: `inverter/p${index}`,
    },
    measurementTime: new Date(Date.UTC(2025, 0, 15, 10, index % 60)),
    value,
    interval: "raw",
  } as unknown as RawObservationInput;
}

beforeEach(() => {
  fake().published.length = 0;
  fake().failNext(0);
});

describe("observationDeliveryOptions", () => {
  const saved = {
    retries: process.env.OBSERVATIONS_RETRIES,
    delay: process.env.OBSERVATIONS_RETRY_DELAY,
    timeout: process.env.OBSERVATIONS_RECEIVE_TIMEOUT_S,
  };

  afterEach(() => {
    for (const [key, value] of [
      ["OBSERVATIONS_RETRIES", saved.retries],
      ["OBSERVATIONS_RETRY_DELAY", saved.delay],
      ["OBSERVATIONS_RECEIVE_TIMEOUT_S", saved.timeout],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("defaults bound a poison message to about five minutes", () => {
    expect(observationDeliveryOptions()).toEqual({
      retries: 3,
      retryDelay: "min(120000, 5000 * pow(3, retried))",
      timeout: 65,
    });
  });

  it("keeps the timeout ABOVE the receiver's 60s maxDuration", () => {
    // If QStash gave up first it would retry while the original invocation is still inside its
    // transaction — two concurrent upserts on the same (point_rid, measurement_time) rows.
    expect(observationDeliveryOptions().timeout).toBeGreaterThan(60);
  });

  it("is tunable without a deploy", () => {
    process.env.OBSERVATIONS_RETRIES = "1";
    process.env.OBSERVATIONS_RECEIVE_TIMEOUT_S = "30";
    expect(observationDeliveryOptions()).toMatchObject({
      retries: 1,
      timeout: 30,
    });
  });
});

describe("every publish site carries the delivery options", () => {
  it("publishPoll — the dominant producer", async () => {
    const collector = createPollCollector();
    collector.add([makeInput(1, 100), makeInput(2, 200)]);
    await publishPoll(device, session, collector);

    expect(fake().published).toHaveLength(1);
    expect(fake().published[0].via).toBe("queue");
    expect(fake().published[0].request).toMatchObject({
      url: RECEIVER_URL,
      ...observationDeliveryOptions(),
    });
  });

  it("publishPoll — options ride EVERY chunk, not just the first", async () => {
    const collector = createPollCollector();
    collector.add(Array.from({ length: 40 }, (_, i) => makeInput(i + 1, i)));
    // A tiny byte budget forces multiple chunks.
    process.env.OBSERVATIONS_MAX_MESSAGE_BYTES = "1200";
    try {
      await publishPoll(device, session, collector);
    } finally {
      delete process.env.OBSERVATIONS_MAX_MESSAGE_BYTES;
    }

    expect(fake().published.length).toBeGreaterThan(1);
    for (const entry of fake().published) {
      expect(entry.request).toMatchObject(observationDeliveryOptions());
    }
  });

  it("publishObservationBatch — the no-collector path", async () => {
    await publishObservationBatch(device, [makeInput(1, 100)]);

    expect(fake().published).toHaveLength(1);
    expect(fake().published[0].request).toMatchObject({
      url: RECEIVER_URL,
      ...observationDeliveryOptions(),
    });
  });
});

/**
 * A structural guard over the sites this suite cannot drive.
 *
 * `drainOutbox` (the relay — the MAIN path) and the DLQ retry-all both need a full drizzle fake to
 * exercise, so instead assert the property that actually matters: every publish in the repo spreads
 * the shared option set. This is what catches a *fifth* publish site being added later, which is the
 * failure mode the module exists to prevent.
 */
describe("no publish site may bypass the shared publisher", () => {
  const PUBLISH_SITES = [
    "lib/observations/outbox.ts",
    "lib/observations/poll-collector.ts",
    "lib/observations/publisher.ts",
    "app/api/admin/observations/dlq/route.ts",
  ];

  it.each(PUBLISH_SITES)("%s calls publishObservationMessage()", (file) => {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    expect(source).toContain("publishObservationMessage(");
  });

  it("routes every raw QStash publish through lib/observations/publish.ts", () => {
    // The whole point of the module: exactly ONE place decides the transport and the delivery
    // bounds. A raw `enqueueJSON`/`publishJSON` anywhere else is a site that inherits QStash's
    // defaults — which is what took ingest down on 2026-09-09.
    //
    // The pattern requires a CALL — a leading dot and an opening paren — not a bare mention. A
    // codebase that documents these APIs heavily will name them in prose, and a guard that trips on
    // a doc comment gets weakened or deleted rather than fixed.
    const { execSync } =
      require("node:child_process") as typeof import("node:child_process");
    const hits = execSync(
      "grep -rln '\\.\\(enqueueJSON\\|publishJSON\\)(' --include='*.ts' lib app scripts packages || true",
      { cwd: process.cwd(), encoding: "utf8" },
    )
      .split("\n")
      .filter((line: string) => line && !line.includes("__tests__"));

    expect(hits).toEqual(["lib/observations/publish.ts"]);
  });
});

describe("flow-control keys", () => {
  it("names one key per lane, prefixed by environment", () => {
    // Tests run with NODE_ENV=test, so this is the non-production prefix.
    expect(OBSERVATIONS_FLOW_PREFIX).toBe("obs-dev");
    expect(observationsFlowKey("live")).toBe("obs-dev.live");
    expect(observationsFlowKey("backfill")).toBe("obs-dev.backfill");
  });

  it("🛑 mints a key QStash will accept — no colon", () => {
    // The 2026-09-10 cutover failure: `publishJSON` 400s with "flowControlKey must be alphanumeric,
    // hyphen, underscore, or period" and the whole ingest path stops. `flowControl.get()` does NOT
    // enforce it, so the read side reported both lanes healthy the entire time.
    for (const lane of ["live", "backfill"] as const) {
      expect(observationsFlowKey(lane)).toMatch(FLOW_KEY_CHARSET);
    }
  });

  it("🛑 keeps the environment prefixes DISJOINT under prefix matching", () => {
    // dev and prod share one QStash account, so an "is this ours?" filter is a prefix test.
    //
    // 🛑 Derived from the REAL key, never from a literal. The previous version of this test asserted
    // `"obs-dev:live".startsWith("obs:")` — a property of two string constants, true regardless of
    // what the code minted. It stayed green for the entire time the code was producing keys QStash
    // would reject. A test that cannot fail when the code is wrong is worse than no test.
    const prodPrefix = "obs"; // the production value of OBSERVATIONS_FLOW_PREFIX
    for (const lane of ["live", "backfill"] as const) {
      const devKey = observationsFlowKey(lane);
      const separator = devKey.slice(
        OBSERVATIONS_FLOW_PREFIX.length,
        -lane.length,
      );
      expect(devKey.startsWith(prodPrefix + separator)).toBe(false);
    }
  });

  it("round-trips a key back to its lane, and rejects anything else", () => {
    expect(parseObservationsFlowKey("obs-dev.live")).toBe("live");
    expect(parseObservationsFlowKey("obs-dev.backfill")).toBe("backfill");
    expect(parseObservationsFlowKey("obs.live")).toBeNull(); // the other environment
    expect(parseObservationsFlowKey("something-else")).toBeNull();
  });

  it("keeps the sum of lane parallelism inside the Postgres pool", () => {
    const pool = Number(process.env.PLANETSCALE_POOL_MAX ?? 10);
    expect(
      laneParallelism("live") + laneParallelism("backfill"),
    ).toBeLessThanOrEqual(pool);
    // Live gets the larger share: it is the traffic that must never wait.
    expect(laneParallelism("live")).toBeGreaterThan(
      laneParallelism("backfill"),
    );
  });
});

describe("messageLane", () => {
  it("defaults to live for a message with no lane — every pre-lane outbox row", () => {
    expect(messageLane({ systemId: 1 } as QueueMessage)).toBe("live");
  });

  it("honours an explicit lane", () => {
    expect(messageLane({ systemId: 1, lane: "backfill" } as QueueMessage)).toBe(
      "backfill",
    );
  });
});

describe("the transport switch", () => {
  const saved = process.env.OBSERVATIONS_PUBLISH_MODE;
  afterEach(() => {
    if (saved === undefined) delete process.env.OBSERVATIONS_PUBLISH_MODE;
    else process.env.OBSERVATIONS_PUBLISH_MODE = saved;
  });

  const message = (lane?: "live" | "backfill"): QueueMessage =>
    ({
      env: "dev",
      lane,
      systemId: 7,
      systemName: "S",
      batchTime: "t",
    }) as QueueMessage;

  it("defaults to the legacy queue", () => {
    expect(publishMode()).toBe("queue");
  });

  it("publishes to the queue in queue mode, with no flow-control key", async () => {
    await publishObservationMessage(message("backfill"));

    expect(fake().published[0].via).toBe("queue");
    expect(fake().published[0].request.flowControl).toBeUndefined();
  });

  it("publishes on the lane's key in flow mode", async () => {
    process.env.OBSERVATIONS_PUBLISH_MODE = "flow";
    await publishObservationMessage(message("backfill"));
    await publishObservationMessage(message("live"));

    expect(fake().published.map((p) => p.via)).toEqual(["flow", "flow"]);
    expect(fake().published[0].request.flowControl).toEqual({
      key: "obs-dev.backfill",
      parallelism: laneParallelism("backfill"),
    });
    expect(fake().published[1].request.flowControl).toEqual({
      key: "obs-dev.live",
      parallelism: laneParallelism("live"),
    });
  });

  it("labels flow messages so they stay findable once queueName goes empty", async () => {
    process.env.OBSERVATIONS_PUBLISH_MODE = "flow";
    await publishObservationMessage(message("live"));

    expect(fake().published[0].request.label).toBe(OBSERVATIONS_FLOW_PREFIX);
  });

  it("carries an IDENTICAL delivery bound on both transports", async () => {
    // The cutover must change only which lane a message waits in — never how long a bad one can
    // hold it. If these ever diverge, flipping the switch changes the blast radius.
    await publishObservationMessage(message("live"));
    process.env.OBSERVATIONS_PUBLISH_MODE = "flow";
    await publishObservationMessage(message("live"));

    const [viaQueue, viaFlow] = fake().published;
    const bound = observationDeliveryOptions();
    expect(viaQueue.request).toMatchObject(bound);
    expect(viaFlow.request).toMatchObject(bound);
  });
});

describe("producers stamp their lane", () => {
  it("a default collector is live", async () => {
    const collector = createPollCollector();
    collector.add([makeInput(1, 100)]);
    await publishPoll(device, session, collector);

    expect((fake().published[0].request.body as QueueMessage).lane).toBe(
      "live",
    );
  });

  it("a backfill collector stamps every chunk, so a replay stays off the live lane", async () => {
    const collector = createPollCollector({ lane: "backfill" });
    collector.add(Array.from({ length: 40 }, (_, i) => makeInput(i + 1, i)));

    process.env.OBSERVATIONS_MAX_MESSAGE_BYTES = "1200";
    try {
      await publishPoll(device, session, collector);
    } finally {
      delete process.env.OBSERVATIONS_MAX_MESSAGE_BYTES;
    }

    expect(fake().published.length).toBeGreaterThan(1);
    for (const entry of fake().published) {
      expect((entry.request.body as QueueMessage).lane).toBe("backfill");
    }
  });
});
