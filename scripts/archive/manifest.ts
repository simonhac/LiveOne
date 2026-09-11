/**
 * Reading a vendor archive's `manifest.md`, and writing the session manifest that will be filed
 * alongside the rows it produces.
 *
 * Two different documents with the same word in their name, and it is worth keeping them apart:
 *
 *   - the ARCHIVE manifest (`manifest.md`, written by `scripts/mondo|selectronic/archive-download`)
 *     describes what was pulled off a vendor and filed on disk. It is the upstream evidence.
 *   - the SESSION manifest (JSON, `sessions.response`) describes what was done to that evidence to
 *     turn it into LiveOne rows. It CITES the first rather than restating it — the archive manifest
 *     already carries checksums, and a copy would be one more thing that can drift.
 *
 * 🛑 The archive manifest is parsed, but it is not TRUSTED over the data. Its own header warns why:
 * "One archive here briefly carried a one-day span beside an eight-year row count, because a retry
 * run had overwritten the manifest" (`scripts/lib/portal-session.ts`). So the CSV's own extent is
 * what bounds a window, and the manifest's declared span is cross-checked against it — a
 * disagreement is a refusal, not a preference.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface ArchiveManifest {
  /** The `# ...` title line. */
  title: string;
  /** Every `| key | value |` row under `## Coverage`. */
  coverage: Record<string, string>;
  /** Whole-day gaps, when the manifest declares them in the standard From/To/Days table. */
  gaps: Array<{ from: string; to: string }>;
  /** sha256 of the manifest file itself — what the session manifest cites. */
  sha256: string;
  path: string;
}

const sha256 = (buf: Buffer | string) =>
  crypto.createHash("sha256").update(buf).digest("hex");

/** Split a markdown table row into trimmed cells, or null if it is not one. */
function cells(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|") || !t.endsWith("|")) return null;
  const parts = t.slice(1, -1).split("|");
  // The `| --- | --- |` separator is not data.
  if (parts.every((p) => /^\s*:?-{3,}:?\s*$/.test(p))) return null;
  return parts.map((p) => p.trim());
}

export function parseArchiveManifest(file: string): ArchiveManifest {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);

  const title = (lines.find((l) => l.startsWith("# ")) ?? "").slice(2).trim();

  let section = "";
  const coverage: Record<string, string> = {};
  const gaps: Array<{ from: string; to: string }> = [];
  for (const line of lines) {
    if (line.startsWith("## ")) {
      section = line.slice(3).trim().toLowerCase();
      continue;
    }
    const c = cells(line);
    if (!c) continue;
    if (section === "coverage" && c.length === 2 && c[0] !== "Field")
      coverage[c[0]] = c[1];
    // Only the standard whole-day gaps table. `splink-15min` lists ISOLATED missing RECORDS under
    // the same heading in a two-column table, which is a different claim and must not be read as a
    // date range — hence the length check and the ISO-date test rather than a positional read.
    if (
      section === "gaps" &&
      c.length === 3 &&
      /^\d{4}-\d{2}-\d{2}$/.test(c[0]) &&
      /^\d{4}-\d{2}-\d{2}$/.test(c[1])
    )
      gaps.push({ from: c[0], to: c[1] });
  }

  return { title, coverage, gaps, sha256: sha256(text), path: file };
}

/** What the transformer did, recorded for `liveone session create --manifest`. */
export interface SessionManifest {
  kind: "archive-import";
  generatedAt: string;
  tool: { name: string; gitSha: string | null; argv: string[] };
  archive: {
    directory: string;
    manifest: { path: string; sha256: string; title: string };
    files: Array<{ path: string; sha256: string }>;
    declaredCoverage: Record<string, string>;
  };
  device: { handle: number | string };
  window: { start: string; end: string; stamp: "interval_start" };
  /** Every column that produced rows, and the point it produced them for. */
  mapping: Array<{
    source: string;
    point: string;
    logicalPath: string | null;
    physicalPath: string;
    unit: string;
    metricType: string;
    rows: number;
  }>;
  /** Named when the values are not the archive's own numbers. Absent for a direct mapping. */
  algorithm?: { name: string; doc: string; notes: string[] };
  rows: number;
}

export function fileDigest(file: string): { path: string; sha256: string } {
  return { path: path.basename(file), sha256: sha256(fs.readFileSync(file)) };
}

/** The commit the transformer ran at, so the mapping can be read back exactly. Null outside a repo. */
export function gitSha(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
