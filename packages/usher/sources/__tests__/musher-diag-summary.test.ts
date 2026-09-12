import { it, expect, jest, afterEach } from "@jest/globals";

const appended: unknown[] = [];
jest.mock("../../core/diag-journal", () => ({
  DiagJournal: {
    create: async () => ({
      append: (r: unknown) => {
        appended.push(r);
      },
      maintain: async () => {},
    }),
  },
}));

// ~94 registers, all but three of them static — the real shape, which is the whole reason the
// journal compresses ~106:1 and the reason the stdout dump was so expensive.
const readings = [
  { field: { key: "batteryV" }, value: 25.4, rawWords: [254] },
  { field: { key: "engineRunTime" }, value: 61234, rawWords: [0, 61234] },
  { field: { key: "controllerTime" }, value: 1789000000, rawWords: [1, 2] },
  // a sentinel: the device answered, but with a not-available code
  {
    field: { key: "oilPressure" },
    value: null,
    rawWords: [65535],
    rawInt: 65535,
  },
  // a read error: no raw words at all
  {
    field: { key: "coolantTemp" },
    value: null,
    rawWords: [],
    error: "timeout",
  },
  ...Array.from({ length: 90 }, (_, i) => ({
    field: { key: `static${i}` },
    value: 0,
    rawWords: [0, 0, 0],
  })),
];

jest.mock("../../clients/dse-client", () => ({
  ...jest.requireActual<object>("../../clients/dse-client"),
  DseClient: class {
    async connect() {}
    async close() {}
    async readAll() {
      return { readings, unitId: 1, pageErrors: [] };
    }
  },
}));

const ORIGINAL = process.env.MUSHER_DIAGNOSTICS;
afterEach(() => {
  process.env.MUSHER_DIAGNOSTICS = ORIGINAL;
  appended.length = 0;
});

/**
 * The stdout copy of the diag dump was 98.9% of this app's entire log payload — measured twice,
 * independently, on 2026-09-12 and 2026-09-13. It was a duplicate of the journal beside it, which
 * is the designed artefact and keeps ~3 months at ~106:1.
 *
 * This test exists because the regression is silent: restoring `JSON.stringify(record)` breaks
 * nothing, passes every other test, and quietly costs ~91% of the fleet's log allowance. The
 * assertion is a SIZE BOUND, deliberately — not an exact string, which would fail on any harmless
 * wording change and get deleted rather than fixed.
 */
it("logs a compact summary to stdout while journalling the FULL record", async () => {
  process.env.MUSHER_DIAGNOSTICS = "1";
  const lines: string[] = [];
  const { createMusher } = await import("../musher");
  const source = createMusher({
    siteId: "site",
    host: "192.0.2.1",
    dataDir: "/tmp/musher-diag-test",
    log: (m: string) => lines.push(m),
  });

  await source.read();
  await new Promise((r) => setTimeout(r, 10)); // journal creation is async and fire-and-forget

  const diag = lines.find((l) => l.includes("[musher-diag]"));
  expect(diag).toBeDefined(); // no [musher-diag] line was emitted

  // ~150 B is the design target; 500 is generous headroom that still catches a full dump (~9 KB).
  expect(diag!.length).toBeLessThan(500);

  // The three fields that actually MOVE between polls must survive — they are the entire point of
  // keeping a live tail at all.
  expect(diag).toContain("batteryV=25.4");
  expect(diag).toContain("runTime=61234");
  expect(diag).toContain("ctrlTime=1789000000");

  // Counts, not contents: "how much of the dump failed" is what a tail needs.
  expect(diag).toContain("sentinels=1");
  expect(diag).toContain("errors=1");

  // 🛑 And the 90 static registers must NOT be there. This is the assertion that fails the moment
  // someone restores the full dump.
  expect(diag).not.toContain("static0");
  expect(diag).not.toContain("rawWords");

  // The other half of the trade: nothing durable was lost. The journal must still get every
  // register, raw words and all — that is what makes the stdout copy redundant rather than a
  // reduction in what is kept.
  expect(appended).toHaveLength(1);
  const record = appended[0] as {
    fields: Record<string, unknown>;
    site: string;
  };
  expect(record.site).toBe("site");
  expect(Object.keys(record.fields)).toHaveLength(readings.length);
  expect(record.fields.static0).toEqual({ v: 0, raw: [0, 0, 0], i: undefined });
  expect(record.fields.batteryV).toMatchObject({ v: 25.4, raw: [254] });
});
