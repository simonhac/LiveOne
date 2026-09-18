import { describe, it, expect } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readResumeAnchors,
  validateEventDownloadOptions,
} from "../event-download";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "selectlive-events-"));
const write = (body: unknown) => {
  const file = path.join(tmp(), "manifest.json");
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
};

describe("validateEventDownloadOptions", () => {
  it("refuses date filtering without a timezone", () => {
    expect(() =>
      validateEventDownloadOptions({ out: "/tmp", start: "2026-09-17" }),
    ).toThrow(/Date filtering requires --timezone/);
  });
  it("refuses an unknown timezone rather than silently using UTC", () => {
    expect(() =>
      validateEventDownloadOptions({ out: "/tmp", timezone: "Mars/Olympus" }),
    ).toThrow(/valid IANA timezone/);
  });
  it("refuses a reversed range", () => {
    expect(() =>
      validateEventDownloadOptions({
        out: "/tmp",
        timezone: "Australia/Melbourne",
        start: "2026-09-18",
        end: "2026-09-17",
      }),
    ).toThrow(/must be before/);
  });
  it("accepts a bounded, zoned request", () => {
    expect(() =>
      validateEventDownloadOptions({
        out: "/tmp",
        timezone: "Australia/Melbourne",
        start: "2026-09-17",
        end: "2026-09-19",
      }),
    ).not.toThrow();
  });
});

describe("readResumeAnchors", () => {
  it("reads the per-log anchors a previous acquisition left", () => {
    const file = write({
      version: 1,
      logs: {
        alert: {
          anchor: { deviceSeconds: 811_430_745, id: "i:alert:811430745:abc" },
        },
        operational: { anchor: null },
      },
    });
    expect(readResumeAnchors(file)).toEqual({
      alert: { deviceSeconds: 811_430_745, id: "i:alert:811430745:abc" },
    });
  });

  it("refuses a manifest it cannot parse, rather than silently doing a FULL read", () => {
    // Quietly falling back would turn "read only what is new" into a several-minute acquisition,
    // and would lose the overlap evidence the resume exists to produce.
    const file = write({ nope: true });
    expect(() => readResumeAnchors(file)).toThrow(
      /previous selectlive events download/,
    );
  });

  it("refuses a file that is not JSON at all", () => {
    const file = path.join(tmp(), "manifest.json");
    fs.writeFileSync(file, "not json");
    expect(() => readResumeAnchors(file)).toThrow(
      /previous selectlive events download/,
    );
  });
});

describe("manifest log seeding", () => {
  it("🛑 carries a previous anchor forward for a log the run never reached", () => {
    // The hole this closes: a resume that failed on the clock read, or partway through the first
    // log, wrote a manifest with NO entry for the logs it never reached. Resuming from that
    // manifest silently did a full read for them — and a full read cannot report a lost overlap, so
    // a ring that wrapped in between produced a clean-looking download with a hole in it.
    const file = write({
      version: 1,
      logs: {
        alert: {
          log: "alert",
          attempted: true,
          acquiredRecords: 3,
          anchor: { deviceSeconds: 100, id: "i:alert:100:aa" },
        },
        operational: {
          log: "operational",
          attempted: false,
          acquiredRecords: 0,
          anchor: { deviceSeconds: 200, id: "i:operational:200:bb" },
        },
      },
    });
    expect(readResumeAnchors(file)).toEqual({
      alert: { deviceSeconds: 100, id: "i:alert:100:aa" },
      operational: { deviceSeconds: 200, id: "i:operational:200:bb" },
    });
  });

  it("reads no anchor for a log that has never completed", () => {
    const file = write({
      version: 1,
      logs: {
        alert: {
          log: "alert",
          attempted: true,
          acquiredRecords: 0,
          anchor: null,
        },
      },
    });
    expect(readResumeAnchors(file)).toEqual({});
  });
});
