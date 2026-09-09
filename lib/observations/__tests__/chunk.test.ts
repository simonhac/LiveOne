/**
 * The chunking contract — both bounds, and the data-never-dropped invariant.
 *
 * The count cap is the one the 2026-09-09 outage needed: that backfill's messages carried ~1650
 * observations each and the byte cap let every one of them through, because 1650 small rows fit
 * inside 900 kB. The first test here is that exact shape.
 */
import { describe, it, expect } from "@jest/globals";
import { buildChunkedMessages } from "../chunk";
import type { Observation, QueueMessage } from "../types";

const base = (): QueueMessage => ({
  env: "dev",
  systemId: 7,
  systemName: "Test System",
  batchTime: "2025-01-15T20:30:00+10:00",
});

function makeObservations(n: number): Observation[] {
  return Array.from(
    { length: n },
    (_, i) =>
      ({
        topic: `liveone/select.live/SITE-123/inverter/p${i}`,
        pointUid: `pt_test${i}`,
        timestamp: "2025-01-15T20:30:00.000+10:00",
        value: i,
        interval: "raw",
      }) as unknown as Observation,
  );
}

/** Every observation appears exactly once, in order, across all chunks. */
function flatten(messages: QueueMessage[]): Observation[] {
  return messages.flatMap((m) => m.observations ?? []);
}

describe("buildChunkedMessages", () => {
  it("splits the incident's 1650-observation message, which the byte cap alone let through", () => {
    const observations = makeObservations(1650);

    // Confirm the premise: 1650 of these fit inside the 900 kB byte bound.
    const oneMessage = { ...base(), observations };
    expect(Buffer.byteLength(JSON.stringify(oneMessage), "utf8")).toBeLessThan(
      900000,
    );

    const messages = buildChunkedMessages({ base, observations });

    expect(messages).toHaveLength(4); // ceil(1650 / 500)
    for (const message of messages) {
      expect(message.observations!.length).toBeLessThanOrEqual(500);
    }
    expect(flatten(messages)).toEqual(observations);
  });

  it("respects the byte cap when it binds before the count cap", () => {
    const observations = makeObservations(40);
    const messages = buildChunkedMessages({
      base,
      observations,
      maxBytes: 1200,
      maxCount: 10000,
    });

    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      expect(
        Buffer.byteLength(JSON.stringify(message), "utf8"),
      ).toBeLessThanOrEqual(1200);
    }
    expect(flatten(messages)).toEqual(observations);
  });

  it("packs into as few chunks as possible", () => {
    const observations = makeObservations(10);
    const messages = buildChunkedMessages({ base, observations, maxCount: 4 });

    expect(messages.map((m) => m.observations!.length)).toEqual([4, 4, 2]);
  });

  it("never drops an observation that exceeds the byte cap on its own", () => {
    const observations = makeObservations(3);
    const messages = buildChunkedMessages({ base, observations, maxBytes: 1 });

    expect(messages).toHaveLength(3);
    expect(flatten(messages)).toEqual(observations);
  });

  it("emits exactly one message when there are no observations", () => {
    const messages = buildChunkedMessages({ base, observations: [] });

    expect(messages).toHaveLength(1);
    expect(messages[0].observations).toBeUndefined();
  });

  it("copies the base onto every chunk, so a session rides them all", () => {
    const session = { sessionId: "s-1" } as QueueMessage["session"];
    const messages = buildChunkedMessages({
      base: () => ({ ...base(), session }),
      observations: makeObservations(7),
      maxCount: 3,
    });

    expect(messages).toHaveLength(3);
    for (const message of messages) {
      expect(message.session).toEqual(session);
    }
  });

  it("treats a maxCount below 1 as 1 rather than looping forever", () => {
    const messages = buildChunkedMessages({
      base,
      observations: makeObservations(3),
      maxCount: 0,
    });

    expect(messages.map((m) => m.observations!.length)).toEqual([1, 1, 1]);
  });
});
