/**
 * Reading a vendor archive's `manifest.md`.
 *
 * 🛑 The case that drives the design is `splink-15min`: under the SAME `## Gaps` heading it lists
 * ISOLATED MISSING RECORDS in a two-column table, not date ranges. Read positionally, its first
 * column would be taken for a `from` date and a 15-minute hole would become a refusal covering a
 * whole day — or worse, a window would be declared safe on the strength of a table that was never
 * about days at all.
 */
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArchiveManifest } from "../manifest";

let dir: string;
const write = (body: string) => {
  const f = path.join(dir, "manifest.md");
  fs.writeFileSync(f, body);
  return f;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-manifest-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const MONDO = `# 57 Kinkora Rd — mondo-5min — exported 2026-09-11

Each row is one 5-MINUTE interval.

## Source

| Field | Value |
| --- | --- |
| Vendor | Mondo (ubi) |

## Coverage

| Field | Value |
| --- | --- |
| Resolution | 5 minutes |
| Span | 2021-01-20 → 2026-09-11 |
| Days missing | 93 |

## Gaps

| From | To | Days |
| --- | --- | --- |
| 2023-10-06 | 2024-01-06 | 93 |
`;

// The shape that would break a positional parser.
const SPLINK = `# Daylesford — splink-15min — exported 2026-09-11

Each row is one retained record from the SP PRO's own detailed log.

## Coverage

| Field | Value |
| --- | --- |
| Resolution | 15 minutes (configured device log interval: 15 min) |
| Span | 2026-07-11T13:00:00+10:00 → 2026-09-11T14:45:00+10:00 |

## Gaps

No whole days are missing. Eight isolated 15-minute records are absent inside the span:

| Missing record (local) | Records |
| --- | --- |
| 2026-08-11T10:30:00+10:00 | 1 |
| 2026-08-21T06:30:00+10:00 | 1 |
`;

describe("parseArchiveManifest", () => {
  it("reads the title and the whole Coverage table", () => {
    const m = parseArchiveManifest(write(MONDO));
    expect(m.title).toBe("57 Kinkora Rd — mondo-5min — exported 2026-09-11");
    expect(m.coverage).toMatchObject({
      Resolution: "5 minutes",
      Span: "2021-01-20 → 2026-09-11",
      "Days missing": "93",
    });
  });

  it("takes Coverage only from its own section", () => {
    // `## Source` is also a two-column Field/Value table immediately above it.
    const m = parseArchiveManifest(write(MONDO));
    expect(m.coverage).not.toHaveProperty("Vendor");
  });

  it("reads whole-day gaps as date ranges", () => {
    expect(parseArchiveManifest(write(MONDO)).gaps).toEqual([
      { from: "2023-10-06", to: "2024-01-06" },
    ]);
  });

  it("does NOT read splink's isolated-record table as date ranges", () => {
    // 🛑 The whole reason gap parsing tests both column count and ISO-date shape. Two columns of
    // timestamps-plus-count is a different claim from a From/To/Days range, and reading it as one
    // would invent gaps that do not exist.
    expect(parseArchiveManifest(write(SPLINK)).gaps).toEqual([]);
  });

  it("still reads Coverage from a manifest whose Gaps section is prose", () => {
    const m = parseArchiveManifest(write(SPLINK));
    expect(m.coverage.Resolution).toMatch(/^15 minutes/);
  });

  it("ignores the table separator row", () => {
    expect(parseArchiveManifest(write(MONDO)).coverage).not.toHaveProperty(
      "---",
    );
  });

  it("digests the manifest so the session record can cite it", () => {
    const a = parseArchiveManifest(write(MONDO));
    const b = parseArchiveManifest(write(`${MONDO}\n<!-- edited -->\n`));
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(b.sha256).not.toBe(a.sha256);
  });
});
