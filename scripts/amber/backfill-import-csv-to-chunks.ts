#!/usr/bin/env tsx
/**
 * Amber import backfill — CSV → chunk files (feeds PHASE 2 insert)
 *
 * Amber support supplied a `/usage` CSV to fill the part of the import-channel-collision
 * gap (system 9, points 2/7/8) that the API's rolling ~90-day window can no longer reach
 * (2025-11-26 → 2026-04-12). See docs/incidents/2025-11-26-amber-import-channel-collision.md.
 *
 * This tool converts that CSV into the SAME raw-`AmberUsageRecord[]` chunk-file shape that
 * `backfill-import-fetch.ts` writes, so the UNCHANGED `backfill-import-insert.ts` (which
 * filters to import/E1 only → points 2/7/8) can ingest it. Reads/writes only local files.
 *
 * ── Timezone (empirically calibrated against the live export oracle) ──────────────────
 * The serving store is keyed on `new Date(record.endTime)` and the Amber batch grids on
 * FIXED UTC+10 / AEST (amber-readings-batch.ts:16-39). The CSV's "NEM Time" column is the
 * matching fixed-+10 interval clock: DB `interval_end` == parse(NEM Time, +10:00). Verified
 * 2026-07-16 against system-9 export pts 5/6 (distinct cost values line up exactly). So each
 * record's endTime = NEM Time @ +10:00; chunks are framed by AEST calendar day (an interval
 * ending at AEST 00:00 belongs to the previous day). No DST handling is required — the CSV's
 * Start/End columns are DST-aware Melbourne local and are deliberately NOT used.
 *
 * CSV columns: Start Time,End Time,NEM Time,NEM Day,Channel Type,Channel Identifier,Price,Usage,Cost
 *   Price → perKwh (c/kWh)   Usage → kwh (kWh)   Cost → cost (cents)   (Cost ≈ Price×Usage, cents)
 *
 * Usage:
 *   npx tsx scripts/amber/backfill-import-csv-to-chunks.ts \
 *     --csv=".context/attachments/FTM0ld/AM000295 - simon holmes à court usage data.csv"
 *   # → writes usage-<aestDay>-<n>d.json chunk files + _b1-export-calibration.tsv to --out
 */
import * as fs from "fs";
import * as path from "path";
import type { AmberUsageRecord } from "../../lib/vendors/amber/types";

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.split("=").slice(1).join("=") : undefined;
}

const CSV = arg("csv");
const OUT_DIR = arg("out") ?? ".context/amber-backfill";
const SYSTEM_ID = Number(arg("system") ?? 9);
const CHUNK_DAYS = Number(arg("chunk") ?? 7);

const AEST_OFFSET_MS = 10 * 3600 * 1000; // fixed +10:00, no DST
const DAY_MS = 86400 * 1000;
const INTERVAL_MS = 30 * 60 * 1000;

if (!CSV) throw new Error("--csv=<path> is required");

/** UTC 'YYYY-MM-DD HH:MM:SS' for a ms instant (psql-friendly, matches DB timestamp text). */
function toSqlUtc(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "");
}
/** AEST calendar-day number for an interval-END instant; an end at AEST 00:00 rolls to the prior day. */
function aestDayNum(endMs: number): number {
  return Math.floor((endMs + AEST_OFFSET_MS - 1) / DAY_MS);
}
/** 'YYYY-MM-DD' for an AEST day number. */
function dayNumToISO(dayNum: number): string {
  return new Date(dayNum * DAY_MS).toISOString().slice(0, 10);
}

interface Row {
  endMs: number;
  channelType: AmberUsageRecord["channelType"];
  channelId: string;
  perKwh: number;
  kwh: number;
  cost: number;
}

function parseCsv(csvPath: string): Row[] {
  const text = fs.readFileSync(csvPath, "utf8");
  const lines = text.split(/\r?\n/);
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    // Columns are unquoted with no embedded commas → plain split is safe.
    const c = line.split(",");
    if (c.length < 9)
      throw new Error(
        `Row ${i + 1}: expected 9 columns, got ${c.length}: ${line}`,
      );
    const nemTime = c[2].trim(); // 'YYYY-MM-DD HH:MM:SS' — the fixed +10 interval clock
    const channelType = c[4].trim() as AmberUsageRecord["channelType"];
    const channelId = c[5].trim();
    const perKwh = Number(c[6]);
    const kwh = Number(c[7]);
    const cost = Number(c[8]);
    if (
      !nemTime ||
      Number.isNaN(perKwh) ||
      Number.isNaN(kwh) ||
      Number.isNaN(cost)
    )
      throw new Error(`Row ${i + 1}: bad field(s): ${line}`);
    // DB interval_end == NEM Time parsed at +10:00 (calibrated). ISO 'T' + explicit offset.
    const endMs = new Date(`${nemTime.replace(" ", "T")}+10:00`).getTime();
    if (Number.isNaN(endMs))
      throw new Error(`Row ${i + 1}: unparseable NEM Time '${nemTime}'`);
    rows.push({ endMs, channelType, channelId, perKwh, kwh, cost });
  }
  return rows;
}

function toRecord(r: Row): AmberUsageRecord {
  return {
    type: "Usage",
    duration: 30,
    date: dayNumToISO(aestDayNum(r.endMs)),
    startTime: new Date(r.endMs - INTERVAL_MS).toISOString(),
    endTime: new Date(r.endMs).toISOString(),
    nemTime: new Date(r.endMs + AEST_OFFSET_MS)
      .toISOString()
      .replace("Z", "+10:00"),
    quality: "billable",
    kwh: r.kwh,
    perKwh: r.perKwh,
    cost: r.cost,
    channelType: r.channelType,
    channelIdentifier: r.channelId,
    renewables: 0,
    spotPerKwh: 0,
    spikeStatus: "none",
    descriptor: "neutral",
  };
}

function main() {
  const rows = parseCsv(CSV!);
  rows.sort((a, b) => a.endMs - b.endMs);
  const byChannel = new Map<string, number>();
  for (const r of rows)
    byChannel.set(r.channelId, (byChannel.get(r.channelId) ?? 0) + 1);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Group records by AEST day, then emit CHUNK_DAYS-wide chunk files (mirrors the fetch shape).
  const firstDay = aestDayNum(rows[0].endMs);
  const lastDay = aestDayNum(rows[rows.length - 1].endMs);
  const byDay = new Map<number, AmberUsageRecord[]>();
  for (const r of rows) {
    const d = aestDayNum(r.endMs);
    (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(toRecord(r));
  }

  let chunkCount = 0;
  let recCount = 0;
  for (let start = firstDay; start <= lastDay; start += CHUNK_DAYS) {
    const days = Math.min(CHUNK_DAYS, lastDay - start + 1);
    const records: AmberUsageRecord[] = [];
    for (let d = start; d < start + days; d++)
      records.push(...(byDay.get(d) ?? []));
    if (records.length === 0) continue;
    const firstDayISO = dayNumToISO(start);
    const outPath = path.join(OUT_DIR, `usage-${firstDayISO}-${days}d.json`);
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          systemId: SYSTEM_ID,
          firstDay: firstDayISO,
          numberOfDays: days,
          fetchedAt: new Date().toISOString(),
          records,
        },
        null,
        2,
      ),
    );
    chunkCount++;
    recCount += records.length;
    console.log(
      `[csv→chunk] ${firstDayISO} +${days}d → ${records.length} records → ${path.basename(outPath)}`,
    );
  }

  // Sidecar: B1/export interval_end + energy(Wh) + cost(cents) for the read-only calibration
  // against live agg_5m pts 5/6 (proves the +10 timezone mapping DST-correct before any write).
  const calRows = rows
    .filter((r) => r.channelId === "B1")
    .map((r) => `${toSqlUtc(r.endMs)}\t${Math.round(r.kwh * 1000)}\t${r.cost}`);
  const calPath = path.join(OUT_DIR, "_b1-export-calibration.tsv");
  fs.writeFileSync(
    calPath,
    "interval_end\tusage_wh\tcost_cents\n" + calRows.join("\n") + "\n",
  );

  console.log(
    `\n[csv→chunk] parsed ${rows.length} rows (${[...byChannel].map(([k, v]) => `${k}=${v}`).join(", ")}); ` +
      `wrote ${recCount} records across ${chunkCount} chunk file(s) → ${OUT_DIR}`,
  );
  console.log(
    `[csv→chunk] AEST day range ${dayNumToISO(firstDay)} .. ${dayNumToISO(lastDay)}`,
  );
  console.log(
    `[csv→chunk] calibration sidecar → ${path.basename(calPath)} (${calRows.length} B1 intervals)`,
  );
}

main();
