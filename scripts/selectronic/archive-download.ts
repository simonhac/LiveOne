#!/usr/bin/env tsx
/**
 * Selectronic SP PRO ARCHIVE DOWNLOADER — the select.live portal's whole history, as CSV.
 *
 *   npx tsx scripts/selectronic/archive-download.ts --system=1234 --out=/path/to/archive
 *   npx tsx scripts/selectronic/archive-download.ts --system=1234 --out=… --from=2024-01-01
 *   npx tsx scripts/selectronic/archive-download.ts --out=… --from-raw=/path/to/old/raw
 *
 * 🛑 **HOURLY is the vendor's floor, and it is not negotiable.** `chartdata`'s `intervals` parameter
 * is a MAX-POINTS cap, not a resolution request: for a single day, values of 25, 26, 30, 36, 48, 72,
 * 96 and 288 ALL return exactly 24 points, and only values below 24 coarsen it. If a finer store
 * existed behind it, 288 would return 288. `range` accepts only 1–4 (day/week/month/year).
 * `/dashboard/hfdata` is the live feed and ignores a date. There is no export and no second host.
 *
 * 🛑 **THE PORTAL CLAMPS, AND SAYS NOTHING.** `chartdata` serves chart history only back to a
 * retention floor that is NOT `getdata`'s `first_date` — that field is the INVERTER's earliest
 * record, which can be years older. Ask for a day before the floor and you get HTTP 200 and a
 * well-formed body containing **the floor day's data**, with no error, no flag and no empty result.
 * The only tell is the echoed `chartdate`. Measured on one site: `first_date` 2018-04-27, chart
 * retention from 2020-07-09, and 804 of 3,060 downloaded days were silently the same 2020-07-09.
 * So every response is checked against the day requested, and a mismatch is recorded as `clamped`
 * and NOT written. Removing that check re-creates an archive that looks complete and is fiction.
 *
 * Sub-hourly Selectronic history exists ONLY inside the inverter — a ring buffer of 4 days at
 * 1-minute logging, 60 at 15-minute, 120 at 30-minute — reachable with SP LINK (Windows) over its
 * Select.live connection type. Different tool, different job, and it cannot reach real history.
 *
 * ## Not to be confused with `liveone selectlive` (`scripts/selectlive/`)
 *
 * That CLI speaks the **SP LINK binary protocol** through the select.live tunnel to reach the
 * INVERTER's own detailed log — sub-hourly, but a short ring buffer (4 days at 1-minute logging,
 * 120 at 30-minute), so it cannot reach real history. This script reads the **web portal's chart
 * API**, which is hourly but goes back years. Different endpoint, different data, different limits;
 * the two are complements, not alternatives. See `docs/vendors/selectlive-cli.md`.
 *
 * Output layout and conventions: the filing convention in hac-admin
 * (`config/energy-monitoring-filing.md`), which the emitted `manifest.md` names.
 */
import fs from "node:fs";
import path from "node:path";
import {
  openSession,
  eachDay,
  sleep,
  args,
  requireFlag,
  localToday,
  cell,
  collapseRuns,
  renderManifest,
} from "../lib/portal-session";

const ORIGIN = "https://select.live";
/**
 * Only used to name the session folder. 🛑 NOT the data's offset: the portal's buckets follow
 * Australia/Melbourne WITH daylight saving — proven by the 23-hour and 25-hour days its own
 * responses return at each transition (e.g. 2025-10-05 has 23, 2026-04-05 has 25).
 */
const OFFSET_MIN = 600;

/** One day of the portal's chart response. */
interface ChartDay {
  chartdate: string;
  datetime: string[];
  solar: number[];
  load: number[];
  grid: number[];
  export: number[];
  soc: number[];
}

const COLUMNS = [
  "timestamp_aest",
  "timestamp_utc",
  "solar_kwh",
  "load_kwh",
  "ac_source_in_kwh",
  "grid_export_kwh",
  "battery_soc_pct",
] as const;

async function main() {
  const A = args();
  const OUT = requireFlag(A, "out", "the archive directory for this site");
  const DELAY_MS = Number(A.delay ?? 200);
  const fromRaw = typeof A["from-raw"] === "string" ? A["from-raw"] : null;

  const session = path.join(OUT, localToday(OFFSET_MIN));
  const work = path.join(OUT, ".work");
  fs.mkdirSync(session, { recursive: true });

  let from: string, to: string, stats: Record<string, number>;

  if (fromRaw) {
    // Re-emit from day files already on disk — no vendor traffic at all. This is how an existing
    // raw archive is converted without re-downloading thousands of days.
    const days = readRawDir(fromRaw);
    from = days[0]?.chartdate ?? "";
    to = days[days.length - 1]?.chartdate ?? "";
    stats = {
      fetched: 0,
      reused: days.length,
      clamped: skippedClamped,
      empty: 0,
      failed: 0,
    };
    writeYears(session, days);
    writeManifest(session, {
      system: String(A.system ?? "unknown"),
      from,
      to,
      days,
      stats,
      source: `${ORIGIN}/dashboard/chartdata/${A.system ?? "?"}`,
      reEmittedFrom: fromRaw,
    });
    console.log(`  ${days.length} days re-emitted from ${fromRaw}`);
    if (skippedClamped)
      console.log(
        `  ${skippedClamped} file(s) skipped: their contents are a different day (portal clamp).`,
      );
    return;
  }

  const SYSTEM = requireFlag(
    A,
    "system",
    "the select.live system number, e.g. --system=1234",
  );
  const { context, page } = await openSession({
    name: "selectronic",
    url: `${ORIGIN}/dashboard/${SYSTEM}`,
    // 🛑 Ask the API, do not look at the URL. After logging in, select.live lands you on /systems,
    // not back on the dashboard you asked for — so a URL test waits forever on a session that is
    // already good. This fetches the endpoint the download itself uses.
    isReady: async (p) =>
      p.evaluate(async (sys) => {
        const r = await fetch(`/dashboard/getdata/${sys}?needfirst=1`, {
          credentials: "include",
          headers: { "X-Requested-With": "XMLHttpRequest" },
        });
        if (!r.ok) return false;
        const j = await r.json().catch(() => null);
        return !!(j && j.items && j.items.first_date);
      }, SYSTEM),
    loginHint: "Log in to select.live in the browser window that just opened.",
  });

  const api = context.request;

  // The portal reports its own extent, so the floor is never hardcoded.
  const live = await api
    .get(`${ORIGIN}/dashboard/getdata/${SYSTEM}?needfirst=1`, {
      headers: { "X-Requested-With": "XMLHttpRequest" },
    })
    .then((r) => r.json());

  from = typeof A.from === "string" ? A.from : live.items.first_date;
  to = typeof A.to === "string" ? A.to : live.items.last_date;
  const days = eachDay(from, to);
  console.log(
    `select.live system ${SYSTEM}: ${from} → ${to} (${days.length} days)\n  out: ${session}\n`,
  );
  if (A["dry-run"]) {
    await context.close();
    return;
  }

  // Day files land in a WORKING directory, not the archive: they make the run resumable, and they
  // are deleted once the CSVs are written. `--keep-raw` keeps them.
  fs.mkdirSync(work, { recursive: true });
  let fetched = 0,
    reused = 0,
    empty = 0,
    failed = 0,
    clamped = 0;

  for (const [i, day] of days.entries()) {
    const file = path.join(work, `${day}.json`);
    const isTrailing = i === days.length - 1;
    if (fs.existsSync(file) && !isTrailing) {
      reused++;
      continue;
    }
    try {
      const res = await api.post(`${ORIGIN}/dashboard/chartdata/${SYSTEM}`, {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
        },
        form: { chartdate: day, range: "1", intervals: "288", shiftdate: "0" },
      });
      const body = await res.json();
      if (!body?.data?.datetime) {
        empty++;
        continue;
      }
      // 🛑 The clamp check. See the header: a pre-retention day returns the floor day's data with a
      // 200 and no other signal.
      if (body.data.chartdate !== day) {
        clamped++;
        continue;
      }
      fs.writeFileSync(file, JSON.stringify(body.data));
      fetched++;
    } catch (err) {
      // One bad day must not cost the other three thousand. Nothing is written, so a re-run
      // picks it up.
      failed++;
      console.warn(`  ${day}: ${(err as Error).message}`);
    }
    if ((i + 1) % 200 === 0 || isTrailing)
      console.log(
        `  ${day}  [${i + 1}/${days.length}]  fetched ${fetched} · reused ${reused} · clamped ${clamped} · empty ${empty} · failed ${failed}`,
      );
    await sleep(DELAY_MS);
  }

  await context.close();
  const parsed = readRawDir(work);
  stats = { fetched, reused, clamped, empty, failed };
  if (clamped)
    console.log(
      `\n  ${clamped} day(s) were CLAMPED: the portal answered with a different day's data and they` +
        ` were discarded. Chart retention starts later than getdata's first_date.`,
    );
  writeYears(session, parsed);
  writeManifest(session, {
    system: SYSTEM,
    from,
    to,
    days: parsed,
    stats,
    source: `${ORIGIN}/dashboard/chartdata/${SYSTEM}`,
  });
  if (!A["keep-raw"]) fs.rmSync(work, { recursive: true, force: true });
}

let skippedClamped = 0;

function readRawDir(dir: string): ChartDay[] {
  const out: ChartDay[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".json")) {
        const day = JSON.parse(fs.readFileSync(p, "utf8")) as ChartDay;
        // Defensive: an archive downloaded before the clamp check existed holds files whose
        // contents are a different day. Trust the CONTENT's own chartdate, and drop anything that
        // disagrees with its filename rather than filing one day under another's name.
        if (day.chartdate === e.name.slice(0, 10)) out.push(day);
        else skippedClamped++;
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => a.chartdate.localeCompare(b.chartdate));
}

/**
 * The portal's bucket labels are Melbourne LOCAL time WITH daylight saving. This archive stores
 * fixed **AEST (+10)** instead, so every row is one hour after the last and a day is always 24 rows.
 *
 * 🛑 Converting needs the offset per ROW, not per day, because the two transition days carry both:
 *
 * - **DST end (first Sunday in April)** — the portal emits `02:00` TWICE, 25 rows for the day. The
 *   first is +11, the second is +10. Only the ORDER distinguishes them; the labels are identical.
 * - **DST start (first Sunday in October)** — `02:00` never occurs, 23 rows. Rows before it are
 *   +10, rows after are +11.
 *
 * Rather than hardcode those dates, each label is resolved against the tz database: try both
 * candidate instants and keep whichever renders back to the same local label. Exactly one matches on
 * an ordinary day; BOTH match inside the repeated hour, which is where the ordering rule applies;
 * neither matches for a time that never happened.
 *
 * Shifting AEDT rows back an hour re-buckets the record — rows migrate across date and year
 * boundaries around each transition — which is the point, and why years are assigned AFTER the
 * conversion rather than from the source day.
 */
const MELBOURNE = "Australia/Melbourne";
const melbourneParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: MELBOURNE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Render a UTC instant as the portal would label it: "YYYY-MM-DD HH:MM" Melbourne local. */
function melbourneLabel(ms: number): string {
  const p = melbourneParts.formatToParts(new Date(ms));
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}`;
}

/** Render a UTC instant at fixed +10. */
function aestLabel(ms: number): string {
  return new Date(ms + 600 * 60_000)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");
}

/**
 * Resolve one portal label to a UTC instant.
 *
 * `seenTwice` is true when this label already appeared earlier in the same day — the second half of
 * the repeated hour at the April transition, which is the +10 reading.
 */
function labelToUtcMs(label: string, seenTwice: boolean): number | null {
  const naive = Date.parse(`${label.replace(" ", "T")}:00Z`);
  if (Number.isNaN(naive)) return null;
  const plus10 = naive - 600 * 60_000;
  const plus11 = naive - 660 * 60_000;
  const ok10 = melbourneLabel(plus10) === label;
  const ok11 = melbourneLabel(plus11) === label;
  if (ok10 && ok11) return seenTwice ? plus10 : plus11; // ambiguous: order decides
  if (ok11) return plus11;
  if (ok10) return plus10;
  return null; // a local time that never existed
}

interface Row {
  ms: number;
  cells: string[];
}

/** One CSV per calendar year. */
function writeYears(session: string, days: ChartDay[]): Row[] {
  const rows: Row[] = [];
  let unresolved = 0;
  for (const d of days) {
    const seen = new Set<string>();
    d.datetime.forEach((label, i) => {
      const twice = seen.has(label);
      seen.add(label);
      const ms = labelToUtcMs(label, twice);
      if (ms === null) {
        // A label the tz database says never happened. Dropping it silently would be the same class
        // of error as the portal clamp, so it is counted and reported.
        unresolved++;
        return;
      }
      rows.push({
        ms,
        cells: [
          aestLabel(ms),
          new Date(ms).toISOString().replace(".000", ""),
          ...[d.solar[i], d.load[i], d.grid[i], d.export[i], d.soc[i]].map(
            cell,
          ),
        ],
      });
    });
  }
  rows.sort((a, b) => a.ms - b.ms);
  if (unresolved)
    console.warn(
      `  ⚠️  ${unresolved} label(s) could not be resolved to an instant`,
    );

  const byYear = new Map<string, string[]>();
  for (const r of rows) {
    const year = r.cells[0].slice(0, 4); // the AEST year, not the source day's
    const list = byYear.get(year) ?? [];
    list.push(r.cells.join(","));
    byYear.set(year, list);
  }
  for (const [year, list] of [...byYear].sort()) {
    fs.writeFileSync(
      path.join(session, `${year}.csv`),
      COLUMNS.join(",") + "\n" + list.join("\n") + "\n",
    );
    console.log(`  ${year}.csv  ${list.length} rows`);
  }
  return rows;
}

function writeManifest(
  session: string,
  o: {
    system: string;
    from: string;
    to: string;
    days: ChartDay[];
    stats: Record<string, number>;
    source: string;
    reEmittedFrom?: string;
  },
) {
  const present = new Set(o.days.map((d) => d.chartdate));
  const missing =
    o.from && o.to ? eachDay(o.from, o.to).filter((d) => !present.has(d)) : [];
  const rows = o.days.reduce((n, d) => n + d.datetime.length, 0);
  const span = o.days.length
    ? { first: o.days[0].chartdate, last: o.days[o.days.length - 1].chartdate }
    : null;

  const UNITS: Record<string, string> = {
    solar_kwh: "kWh",
    load_kwh: "kWh",
    ac_source_in_kwh: "kWh",
    grid_export_kwh: "kWh",
    battery_soc_pct: "%",
  };
  const withData = o.days.filter((d) => d.datetime.length > 0);
  const nonBlank = (k: keyof ChartDay) =>
    withData.filter((d) =>
      (d[k] as (number | null)[]).some((v) => v !== null && v !== undefined),
    ).length;
  const series: [string, keyof ChartDay][] = [
    ["solar_kwh", "solar"],
    ["load_kwh", "load"],
    ["ac_source_in_kwh", "grid"],
    ["grid_export_kwh", "export"],
    ["battery_soc_pct", "soc"],
  ];

  fs.writeFileSync(
    path.join(session, "manifest.md"),
    renderManifest({
      title: `Daylesford — selectlive-hourly — exported ${path.basename(session)}`,
      intro:
        "Each row is one HOUR, stamped with the START of the bucket in LOCAL time " +
        "(Australia/Melbourne, daylight saving applied). Energy columns are kWh accumulated within " +
        "that hour; battery state of charge is the percentage at that time. Hourly is the portal's " +
        "finest resolution, not a choice made here.",
      source: [
        ["Vendor", "Selectronic"],
        ["Portal", "select.live"],
        ["System", o.system],
        ["Endpoint", o.source],
        ["Exporter", "liveone scripts/selectronic/archive-download.ts"],
      ],
      coverage: [
        ["Resolution", "1 hour"],
        [
          "Timezone",
          "fixed AEST (+10) — converted from the portal's DST-following local time",
        ],
        ["Span", span ? `${span.first} → ${span.last}` : "—"],
        ["Days present", String(o.days.length)],
        [
          "Days with no readings",
          String(o.days.filter((d) => d.datetime.length === 0).length),
        ],
        ["Days missing", String(missing.length)],
        ["Rows", rows.toLocaleString("en-AU")],
      ],
      gaps: collapseRuns(missing),
      columns: [
        {
          column: "timestamp_aest",
          units: "fixed +10, bucket START",
          first: span?.first ?? null,
          last: span?.last ?? null,
          days: withData.length,
          blank: "0",
        },
        {
          column: "timestamp_utc",
          units: "ISO 8601 UTC — the same instant",
          first: span?.first ?? null,
          last: span?.last ?? null,
          days: withData.length,
          blank: "0",
        },
        ...series.map(([col, key]) => {
          const d = nonBlank(key);
          return {
            column: col,
            units: UNITS[col],
            first: span?.first ?? null,
            last: span?.last ?? null,
            days: d,
            blank: String(withData.length - d),
          };
        }),
      ],
      notes: [
        '`ac_source_in_kwh` is the portal\'s "Gen Import". The site is OFF-GRID, so the AC source is the generator, not a mains connection.',
        "Hourly is the vendor's floor. `chartdata`'s `intervals` parameter is a max-points cap, not a resolution request \u2014 a day returns 24 points whether asked for 25 or 288.",
        "🛑 The span starts at the PORTAL's chart-retention floor, which is later than the inverter's own `first_date`. Asked for an earlier day, `chartdata` returns the floor day's data with a 200 and no error \u2014 so earlier days are absent here by design, not by omission.",
        "Sub-hourly data for this inverter exists only in its internal ring buffer; see the `splink-15min` source alongside this one.",
        "Blank cells mean the portal returned no value. They are not zeros.",
        "A day counted as present but with no readings is one the portal acknowledged and had nothing for \u2014 a site outage, not a hole in this export. Such days contribute no rows.",
        "🛑 Timestamps here are FIXED +10 and are NOT what the portal returns. It labels buckets in Melbourne local time with daylight saving \u2014 23-hour and 25-hour days at the transitions, with an hour repeated each April. Those have been resolved to instants and re-bucketed, so every AEST day is 24 rows and every row is exactly one hour after the last.",
        "Because AEDT rows shift back an hour, rows near a transition belong to a different calendar day here than the portal filed them under. Compare against the portal by instant, not by label.",
      ],
      provenance: [
        ["Generated", new Date().toISOString()],
        [
          "Run",
          `fetched ${o.stats.fetched}, reused ${o.stats.reused}, clamped ${o.stats.clamped ?? 0}, empty ${o.stats.empty}, failed ${o.stats.failed}`,
        ],
        ...(o.reEmittedFrom
          ? ([["Re-emitted from", o.reEmittedFrom]] as [string, string][])
          : []),
        ["Convention", "config/energy-monitoring-filing.md (hac-admin)"],
      ],
    }),
  );
  console.log(
    `  manifest.md  ${o.days.length} days, ${missing.length} missing, ${rows} rows`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
