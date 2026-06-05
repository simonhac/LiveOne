import { describe, it, expect } from "@jest/globals";
import { buildPollMessages, createPollCollector } from "../poll-collector";
import type { RawObservationInput } from "../publisher";
import type { Session } from "../types";
import type { SystemWithPolling } from "@/lib/systems-manager";

// Minimal SystemWithPolling fixture. Only the fields read by buildPollMessages
// / buildObservations matter; everything else is cast away.
const system = {
  id: 1,
  displayName: "Test System",
  vendorType: "select.live",
  vendorSiteId: "SITE-123",
  timezoneOffsetMin: 600,
} as unknown as SystemWithPolling;

// Minimal Session fixture.
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

/**
 * Build a RawObservationInput fixture. `index` must be a positive integer
 * because PointReference.fromIds rejects non-positive ids.
 */
function makeInput(index: number, value: number): RawObservationInput {
  return {
    sessionId: session.sessionId,
    point: {
      metricType: "power",
      metricUnit: "W",
      displayName: `Point ${index}`,
      physicalPathTail: `source.solar.${index}/power`,
      index,
    } as unknown as RawObservationInput["point"],
    value,
    measurementTimeMs: 1_700_000_000_000 + index * 1000,
    receivedTimeMs: 1_700_000_000_500 + index * 1000,
    interval: "raw",
  };
}

describe("buildPollMessages", () => {
  it("small poll → exactly 1 message with session and all observations in order", () => {
    const inputs = [makeInput(1, 100), makeInput(2, 200), makeInput(3, 300)];

    const messages = buildPollMessages({ system, session, inputs });

    expect(messages).toHaveLength(1);
    const [message] = messages;
    expect(message.session).toEqual(session);
    expect(message.observations).toBeDefined();
    expect(message.observations).toHaveLength(3);
    expect(message.observations!.map((o) => o.value)).toEqual([100, 200, 300]);
    // Sanity: identity / metadata of the message.
    expect(message.systemId).toBe(system.id);
    expect(message.systemName).toBe(system.displayName);
    expect(typeof message.batchTime).toBe("string");
    expect(["prod", "dev"]).toContain(message.env);
  });

  it("over-limit → multiple chunks, same session, observations reproduced with no dupes/gaps", () => {
    const inputs = Array.from({ length: 8 }, (_, i) => makeInput(i + 1, i + 1));

    // Tiny maxBytes forces many chunks (each message base + session is already
    // larger than this, so chunks will hold one observation each).
    const messages = buildPollMessages({
      system,
      session,
      inputs,
      maxBytes: 400,
    });

    expect(messages.length).toBeGreaterThan(1);

    // Every chunk repeats the same session.
    for (const message of messages) {
      expect(message.session).toEqual(session);
    }

    // Concatenating chunks reproduces the full ordered observation list with no
    // duplicates and no gaps.
    const allObservations = messages.flatMap((m) => m.observations ?? []);
    expect(allObservations).toHaveLength(inputs.length);
    expect(allObservations.map((o) => o.value)).toEqual(
      inputs.map((i) => i.value),
    );
  });

  it("empty inputs → exactly 1 message with session and no/empty observations", () => {
    const messages = buildPollMessages({ system, session, inputs: [] });

    expect(messages).toHaveLength(1);
    const [message] = messages;
    expect(message.session).toEqual(session);
    // Session-only message carries no observations.
    expect(message.observations ?? []).toHaveLength(0);
  });

  it("one observation + tiny maxBytes → still exactly 1 message (data never dropped)", () => {
    const inputs = [makeInput(1, 42)];

    // maxBytes far smaller than even a single-observation message.
    const messages = buildPollMessages({
      system,
      session,
      inputs,
      maxBytes: 10,
    });

    expect(messages).toHaveLength(1);
    const [message] = messages;
    expect(message.session).toEqual(session);
    expect(message.observations).toHaveLength(1);
    expect(message.observations![0].value).toBe(42);
  });

  it("packs multiple observations into as few chunks as possible under a moderate limit", () => {
    const inputs = Array.from({ length: 10 }, (_, i) =>
      makeInput(i + 1, i + 1),
    );

    // Compute the size of a single-observation message, then allow ~3 per chunk.
    const single = buildPollMessages({
      system,
      session,
      inputs: [makeInput(1, 1)],
      maxBytes: 10,
    });
    const singleBytes = Buffer.byteLength(JSON.stringify(single[0]), "utf8");
    // Roughly room for 3 observations per chunk.
    const obsBytes =
      Buffer.byteLength(JSON.stringify(single[0].observations![0]), "utf8") + 1;
    const maxBytes = singleBytes + obsBytes * 2 + 5;

    const messages = buildPollMessages({ system, session, inputs, maxBytes });

    // Should be fewer messages than one-per-observation.
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.length).toBeLessThan(inputs.length);

    // Every produced message must respect the size limit.
    for (const message of messages) {
      expect(
        Buffer.byteLength(JSON.stringify(message), "utf8"),
      ).toBeLessThanOrEqual(maxBytes);
    }

    // No data lost, order preserved.
    const allObservations = messages.flatMap((m) => m.observations ?? []);
    expect(allObservations.map((o) => o.value)).toEqual(
      inputs.map((i) => i.value),
    );
  });
});

describe("createPollCollector", () => {
  it("add() twice accumulates inputs in insertion order", () => {
    const collector = createPollCollector();

    collector.add([makeInput(1, 100), makeInput(2, 200)]);
    collector.add([makeInput(3, 300)]);

    expect(collector.observations).toHaveLength(3);
    expect(collector.observations.map((o) => o.value)).toEqual([100, 200, 300]);
    expect(collector.observations.map((o) => o.point.index)).toEqual([1, 2, 3]);
  });

  it("starts empty", () => {
    const collector = createPollCollector();
    expect(collector.observations).toHaveLength(0);
  });
});
