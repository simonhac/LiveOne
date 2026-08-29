import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";

// `modbus-serial` is a runtime dep of the DSE client, imported transitively by the factory. Nothing
// here touches Modbus, so a bare stub is enough.
//
// NOT `{ virtual: true }`: the module IS installed. Registering it virtually while another suite
// mocks it normally corrupts the resolver when the two share a jest worker — the other suite then
// gets the REAL library and dials the real generator's IP. (Observed as an intermittent
// `connect EHOSTUNREACH 10.0.1.244:502` in musher-mutex.test.ts.) Keep both mocks the same shape.
jest.mock("modbus-serial", () => ({ __esModule: true, default: class {} }));

import { buildEntries } from "../factory";
import { UsherConfigSchema } from "../config";

/**
 * Regression cover for a silent wiring bug: `buildEntries` used to destructure the cadence object
 * field by field, so cadences added to `cadenceFor` were dropped on the floor. Nothing threw — the
 * run-loop simply fell back to its defaults, and a deploy that looked green pushed at the POLL rate.
 */
const base = {
  gushEndpoint: "http://localhost/gush",
  sources: [
    {
      type: "deepsea",
      siteId: "s",
      apiKeyEnv: "TEST_KEY",
      host: "127.0.0.1",
      pollSec: 15,
      activeSec: 15,
      pushSec: 300,
      activePushSec: 60,
    },
  ],
};

beforeEach(() => {
  process.env.TEST_KEY = "gk_test";
});
afterEach(() => {
  delete process.env.TEST_KEY;
});

describe("buildEntries cadence wiring", () => {
  it("carries the deepsea push cadences through to the scheduled entry", () => {
    const [entry] = buildEntries(UsherConfigSchema.parse(base), () => {});
    expect(entry.intervalMs).toBe(15_000);
    expect(entry.activeIntervalMs).toBe(15_000);
    expect(entry.pushIntervalMs).toBe(300_000);
    expect(entry.activePushIntervalMs).toBe(60_000);
  });

  it("defaults push to poll when the config omits it (unchanged for every other deployment)", () => {
    const cfg = structuredClone(base);
    delete (cfg.sources[0] as Record<string, unknown>).pushSec;
    delete (cfg.sources[0] as Record<string, unknown>).activePushSec;
    const [entry] = buildEntries(UsherConfigSchema.parse(cfg), () => {});
    expect(entry.pushIntervalMs).toBe(entry.intervalMs);
    expect(entry.activePushIntervalMs).toBe(entry.intervalMs);
  });

  it("activePushSec falls back to pushSec, not to pollSec", () => {
    const cfg = structuredClone(base);
    delete (cfg.sources[0] as Record<string, unknown>).activePushSec;
    const [entry] = buildEntries(UsherConfigSchema.parse(cfg), () => {});
    expect(entry.pushIntervalMs).toBe(300_000);
    expect(entry.activePushIntervalMs).toBe(300_000);
  });
});
