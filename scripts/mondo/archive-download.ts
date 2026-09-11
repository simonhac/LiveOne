#!/usr/bin/env tsx
/**
 * Mondo ARCHIVE DOWNLOADER — a site's whole 5-minute history from the analysis API, as CSV.
 *
 *   npx tsx scripts/mondo/archive-download.ts --out=/path/to/archive
 *   npx tsx scripts/mondo/archive-download.ts --out=… --group="57 Example Rd" --from=2024-01-01
 *   npx tsx scripts/mondo/archive-download.ts --out=… --from-raw=/path/to/old/raw
 *
 * Returns per-monitoring-point WATTS averaged over each 5-minute interval, plus battery state of
 * charge and computed site load — the last two being things the live `/subcircuit/` poll cannot see
 * at all.
 *
 * Two things that will waste an afternoon if you forget them:
 *
 * 🛑 `getDayEnergy` takes the monitoring point GROUP id. A monitoring POINT id returns **403**, not
 * 404, so a wrong id reads as a permissions problem rather than a wrong address.
 *
 * 🛑 A "day" runs local-midnight to local-midnight, so its keys are UTC timestamps that START on the
 * PREVIOUS UTC day. Any window expressed in UTC therefore spans two day requests.
 *
 * 🛑 **The record is not contiguous, so this SCANS from a floor rather than searching for a start.**
 * An earlier version found the earliest day by exponential probe plus binary search — twenty
 * requests instead of a thousand, and wrong: for one real site, days in 2021 and 2022 return full
 * data, a 93-day block in late 2023 returns nothing, and the first day after it is partial. Any
 * search that stops at the first miss reports the far side of that hole as the beginning of history
 * and silently discards years. The verification pass missed it too, because a week, a month and
 * three months further back all landed inside the same gap. An empty day costs one request and
 * writes nothing, and the manifest counts them — so gaps end up described rather than assumed.
 *
 * Output layout and conventions: the filing convention in hac-admin
 * (`config/energy-monitoring-filing.md`), which the emitted `manifest.md` names.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { APIRequestContext, Page } from "@playwright/test";
import {
  openSession,
  eachDay,
  sleep,
  args,
  requireFlag,
  localToday,
  cell,
  csvHeader,
  collapseRuns,
  renderManifest,
} from "../lib/portal-session";

const PLATFORM = "https://platform.mondopower.com.au";
const API = "https://api.mondopower.com.au";
const ANALYSIS = "https://analysis.mondopower.com.au";
const OIDC_KEY =
  "oidc.user:https://identity.mondopower.com.au:platform.frontend";
/** Melbourne; used only to name the session folder. Day boundaries come from the vendor. */
const OFFSET_MIN = 600;
const DEFAULT_FROM = "2020-01-01";

interface DayEnergy {
  energyData?: Record<string, Record<string, number | null>>;
  batterySocData?: Record<string, Record<string, number | null>>;
  siteLoadData?: Record<string, number | null>;
  monitoringPoints?: Record<string, { name?: string; loadType?: string }>;
  timezone?: string;
}

/**
 * 🛑 Re-read the token from the live page before EVERY request. These expire in minutes and a full
 * run takes about an hour; the SPA renews in the background, so the page is the only thing that
 * knows the current one. Caching it in a variable kills the run partway through.
 */
const tokenFrom = (page: Page) =>
  page.evaluate((k) => {
    const raw = localStorage.getItem(k) || sessionStorage.getItem(k);
    return raw ? JSON.parse(raw).access_token : null;
  }, OIDC_KEY);

async function getDay(
  api: APIRequestContext,
  page: Page,
  groupId: string,
  pointIds: string[],
  date: string,
): Promise<DayEnergy> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const token = await tokenFrom(page);
    const res = await api.post(`${ANALYSIS}/getDayEnergy`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      data: {
        monitoringPointGroupId: groupId,
        monitoringPointIds: pointIds,
        mode: "date",
        date,
      },
    });
    if (res.ok()) return res.json();
    // A 401 mid-run means the token turned over between read and use; re-reading fixes it. Anything
    // else gets the same backoff, because the alternative is abandoning a multi-hour run on a blip.
    if (attempt === 3)
      throw new Error(`getDayEnergy ${date} → ${res.status()}`);
    await sleep(1500 * attempt);
  }
  throw new Error("unreachable");
}

const hasData = (d: DayEnergy | null | undefined) =>
  !!d?.energyData && Object.keys(d.energyData).length > 0;

async function main() {
  const A = args();
  const OUT = requireFlag(A, "out", "the archive directory for this site");
  const DELAY_MS = Number(A.delay ?? 200);
  const fromRaw = typeof A["from-raw"] === "string" ? A["from-raw"] : null;

  const session = path.join(OUT, localToday(OFFSET_MIN));
  const work = path.join(OUT, ".work");
  fs.mkdirSync(session, { recursive: true });

  if (fromRaw) {
    // Re-emit from day files already on disk — no vendor traffic at all.
    const days = readRawDir(fromRaw);
    emit(session, days, {
      group: {
        id: String(A.group ?? "unknown"),
        name: String(A["group-name"] ?? "unknown"),
      },
      from: days[0]?.date ?? "",
      to: days[days.length - 1]?.date ?? "",
      stats: { fetched: 0, reused: days.length, empty: 0, failed: 0 },
      source: `${ANALYSIS}/getDayEnergy`,
      reEmittedFrom: fromRaw,
    });
    return;
  }

  const { context, page } = await openSession({
    name: "mondo",
    url: PLATFORM,
    isReady: (p) =>
      p.evaluate(
        (k) => !!(localStorage.getItem(k) || sessionStorage.getItem(k)),
        OIDC_KEY,
      ),
    loginHint:
      "Log in to the Mondo (ubi) platform in the browser window that just opened.",
  });

  const api = context.request;
  const auth = async () => ({
    Authorization: `Bearer ${await tokenFrom(page)}`,
    "Content-Type": "application/json",
  });

  const orgs = await api
    .get(`${API}/monitoring/organizations`, { headers: await auth() })
    .then((r) => r.json());
  const groups = await api
    .get(
      `${API}/monitoring/organizations/${orgs[0].id}/monitoringpointgroups`,
      { headers: await auth() },
    )
    .then((r) => r.json());
  const wanted = typeof A.group === "string" ? A.group : null;
  const group = wanted
    ? groups.find(
        (g: { id: string; name: string }) =>
          g.id === wanted || g.name === wanted,
      )
    : groups[0];
  if (!group) {
    console.error(
      `error: no monitoring point group matching "${wanted}". Available: ${groups.map((g: { name: string }) => g.name).join(", ")}`,
    );
    process.exit(2);
  }

  const devices = await api
    .post(`${ANALYSIS}/getDevicesWithLastReading`, {
      headers: await auth(),
      data: { monitoringPointGroupId: group.id },
    })
    .then((r) => r.json());
  const pointIds: string[] = devices.monitoringPointGroups[0].devices.map(
    (d: { monitoringPointId: string }) => d.monitoringPointId,
  );

  const from = typeof A.from === "string" ? A.from : DEFAULT_FROM;
  const to = typeof A.to === "string" ? A.to : localToday(OFFSET_MIN);
  const days = eachDay(from, to);
  console.log(
    `Mondo "${group.name}" — ${pointIds.length} monitoring points\n  out: ${session}\n` +
      `  ${from} → ${to} (${days.length} days, 5-minute)\n` +
      `  note: the record has gaps; empty days are counted, not treated as the end of history.\n`,
  );
  if (A["dry-run"]) {
    await context.close();
    return;
  }

  fs.mkdirSync(work, { recursive: true });
  let fetched = 0,
    reused = 0,
    empty = 0,
    failed = 0;

  for (const [i, day] of days.entries()) {
    const file = path.join(work, `${day}.json.gz`);
    const isTrailing = i === days.length - 1;
    if (fs.existsSync(file) && !isTrailing) {
      reused++;
      continue;
    }
    try {
      const body = await getDay(api, page, group.id, pointIds, day);
      if (!hasData(body)) {
        empty++;
        continue;
      }
      fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(body)));
      fetched++;
    } catch (err) {
      failed++;
      console.warn(`  ${day}: ${(err as Error).message}`);
    }
    if ((i + 1) % 100 === 0 || isTrailing)
      console.log(
        `  ${day}  [${i + 1}/${days.length}]  fetched ${fetched} · reused ${reused} · empty ${empty} · failed ${failed}`,
      );
    await sleep(DELAY_MS);
  }

  await context.close();
  emit(session, readRawDir(work), {
    group: { id: group.id, name: group.name },
    from,
    to,
    stats: { fetched, reused, empty, failed },
    source: `${ANALYSIS}/getDayEnergy`,
  });
  if (!A["keep-raw"]) fs.rmSync(work, { recursive: true, force: true });
}

interface LoadedDay {
  date: string;
  body: DayEnergy;
}

function readRawDir(dir: string): LoadedDay[] {
  const out: LoadedDay[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".json.gz"))
        out.push({
          date: e.name.slice(0, 10),
          body: JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString()),
        });
    }
  };
  walk(dir);
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** `Meter (Mains Power)` → `meter_mains_power_w`. Stable, lowercase, no punctuation. */
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

function emit(
  session: string,
  days: LoadedDay[],
  o: {
    group: { id: string; name: string };
    from: string;
    to: string;
    stats: Record<string, number>;
    source: string;
    reEmittedFrom?: string;
  },
) {
  // 🛑 Columns come from the UNION of every point ever seen, not from today's device list. Circuits
  // come and go over years — a battery absent for months, a second solar inverter added later — and
  // a schema built from the current set would silently drop the others.
  const names = new Map<string, string>();
  const seen = new Map<string, { days: number; first: string; last: string }>();
  for (const { date, body } of days) {
    for (const [id, m] of Object.entries(body.monitoringPoints ?? {}))
      if (m?.name) names.set(id, m.name);
    const present = new Set<string>();
    for (const v of Object.values(body.energyData ?? {}))
      for (const k of Object.keys(v)) present.add(k);
    for (const id of present) {
      const s = seen.get(id);
      if (s) {
        s.days++;
        s.last = date;
      } else seen.set(id, { days: 1, first: date, last: date });
    }
  }
  const ids = [...seen.keys()].sort((a, b) =>
    (names.get(a) ?? a).localeCompare(names.get(b) ?? b),
  );
  const socDays = days.filter(
    (d) => Object.keys(d.body.batterySocData ?? {}).length > 0,
  ).length;
  const siteLoadDays = days.filter(
    (d) => Object.keys(d.body.siteLoadData ?? {}).length > 0,
  ).length;
  const header = [
    "timestamp_utc",
    "timestamp_local",
    ...ids.map((id) => csvHeader(`${slug(names.get(id) ?? id)}_w`)),
    "battery_soc_pct",
    "site_load_w",
  ].join(",");

  const tz =
    days.find((d) => d.body.timezone)?.body.timezone ?? "Australia/Melbourne";
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const byYear = new Map<string, string[]>();
  let rows = 0;
  for (const { body } of days) {
    const socByTs = body.batterySocData ?? {};
    for (const ts of Object.keys(body.energyData ?? {}).sort()) {
      const vals = body.energyData![ts];
      // `timestamp_local` is written out rather than left to the reader: Melbourne is +10/+11, so
      // nobody can reconstruct it from UTC without knowing the DST rule for that date.
      const local = fmt.format(new Date(ts)).replace(" ", " ");
      const socRow = socByTs[ts];
      const soc = socRow
        ? Object.values(socRow).find((v) => v !== null && v !== undefined)
        : undefined;
      const line = [
        ts,
        local,
        ...ids.map((id) => cell(vals?.[id])),
        cell(soc),
        cell(body.siteLoadData?.[ts]),
      ].join(",");
      const year = local.slice(0, 4);
      const list = byYear.get(year) ?? [];
      list.push(line);
      byYear.set(year, list);
      rows++;
    }
  }
  for (const [year, list] of [...byYear].sort()) {
    fs.writeFileSync(
      path.join(session, `${year}.csv`),
      header + "\n" + list.join("\n") + "\n",
    );
    console.log(`  ${year}.csv  ${list.length} rows`);
  }

  const present = new Set(days.map((d) => d.date));
  const missing =
    o.from && o.to ? eachDay(o.from, o.to).filter((d) => !present.has(d)) : [];
  const span = days.length
    ? { first: days[0].date, last: days[days.length - 1].date }
    : null;

  fs.writeFileSync(
    path.join(session, "manifest.md"),
    renderManifest({
      title: `${o.group.name} — mondo-5min — exported ${path.basename(session)}`,
      intro:
        "Each row is one 5-MINUTE interval. `timestamp_utc` is the vendor's own key; " +
        "`timestamp_local` is the same instant in the site timezone with DST applied, written out " +
        "because nobody can reconstruct it from UTC without knowing the rule for that date. Circuit " +
        "columns are WATTS averaged over the interval — not energy — plus battery state of charge " +
        "and the vendor's computed site load, neither of which the live poll can see at all.",
      source: [
        ["Vendor", "Mondo (ubi)"],
        ["Portal", "platform.mondopower.com.au"],
        ["Monitoring point group", `${o.group.name} (${o.group.id})`],
        ["Endpoint", o.source],
        ["Exporter", "liveone scripts/mondo/archive-download.ts"],
      ],
      coverage: [
        ["Resolution", "5 minutes"],
        ["Timezone", tz],
        ["Span", span ? `${span.first} → ${span.last}` : "—"],
        ["Days present", String(days.length)],
        ["Days missing", String(missing.length)],
        ["Rows", rows.toLocaleString("en-AU")],
      ],
      gaps: collapseRuns(missing),
      columns: [
        {
          column: "timestamp_utc",
          units: "ISO 8601 UTC",
          first: span?.first ?? null,
          last: span?.last ?? null,
          days: days.length,
          blank: "0",
        },
        {
          column: "timestamp_local",
          units: `ISO 8601 ${tz}, DST applied`,
          first: span?.first ?? null,
          last: span?.last ?? null,
          days: days.length,
          blank: "0",
        },
        ...ids.map((id) => {
          const c = seen.get(id)!;
          return {
            column: `${slug(names.get(id) ?? id)}_w`,
            units: "watts, averaged over the interval",
            first: c.first,
            last: c.last,
            days: c.days,
            blank: String(days.length - c.days),
          };
        }),
        {
          column: "battery_soc_pct",
          units: "%",
          first: null,
          last: null,
          days: socDays,
          blank: String(days.length - socDays),
        },
        {
          column: "site_load_w",
          units: "watts (vendor-computed)",
          first: null,
          last: null,
          days: siteLoadDays,
          blank: String(days.length - siteLoadDays),
        },
      ],
      notes: [
        "🛑 A blank circuit column is a circuit that was NOT REPORTING, not one drawing zero watts. Circuits come and go across the record — see Days/Blank above.",
        "Columns are the union of every point ever seen, not the site's current device list; a schema built from today would drop every decommissioned series.",
        'A vendor "day" runs local-midnight to local-midnight, so its UTC keys start on the previous UTC day. A window expressed in UTC spans two day requests.',
        "Missing days are the vendor's own gaps. `getDayEnergy` returns nothing for them, and re-fetching does not fill them.",
      ],
      provenance: [
        ["Generated", new Date().toISOString()],
        [
          "Run",
          `fetched ${o.stats.fetched}, reused ${o.stats.reused}, empty ${o.stats.empty}, failed ${o.stats.failed}`,
        ],
        ...(o.reEmittedFrom
          ? ([["Re-emitted from", o.reEmittedFrom]] as [string, string][])
          : []),
        ["Convention", "config/energy-monitoring-filing.md (hac-admin)"],
      ],
    }),
  );
  console.log(
    `  manifest.md  ${days.length} days, ${missing.length} missing, ${ids.length} points`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
