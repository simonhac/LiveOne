/**
 * `liveone device readings` — a device's RAW readings, untransformed, µs-exact, for evidence.
 *
 * Reads `GET /api/v4/devices/{id}/readings` page by page until `nextCursor` is null, echoing the
 * server-minted `asOf` so every page is the same snapshot. Until this existed, acquiring an
 * incident window's raw rows meant minting a prod database role and running a one-off script (the
 * 17 September 2026 Daylesford outage evidence was gathered exactly that way); this returns the
 * same rows — every point including inactive ones, all three timestamps at microsecond precision —
 * as the operator, with a `lo_cli_` token.
 *
 * `device history` is the tool for looking at a series. This one is for keeping a record of it.
 */
import fs from "node:fs";
import { EXIT, type CommandSpec, type Ctx } from "@/lib/cli/cli";
import { withApiSession } from "@/lib/cli-kit/api-session";
import { BASE_URL_FLAG, resolveDevice, str, toCsv, usage } from "../shared";

const MAX_SPAN_MS = 7 * 86_400_000;

export const readingsSpec = {
  name: "readings",
  summary:
    "A device's RAW readings over a window — every point, untransformed, µs timestamps — for evidence.",
  when:
    "Use this to KEEP a record of what was stored (an incident bundle, a vendor dispute): the raw\n" +
    "rows, exactly as written, with their session ids. To LOOK at a series use `device history`;\n" +
    "to ask whether a series is complete use `device coverage`.",
  description:
    "--since/--until are ISO instants with a zone (half-open: since <= t < until), at most 7 days.\n" +
    "Every point of the device is included, INACTIVE ones too, unless narrowed by --point (pt_…)\n" +
    "or --series (a glob over the logical path, e.g. 'load/*', or the physical-path tail).\n" +
    "\n" +
    "Values are RAW-UNTRANSFORMED: a point's `transform` ('i' = stored inverted) is reported in\n" +
    "the points block but not applied. measurementTime, receivedTime and createdAt (ingestion)\n" +
    "are UTC strings with all six fractional digits.\n" +
    "\n" +
    "Pages are fetched until the server says done; the first page's `asOf` (the database clock)\n" +
    "is echoed on every later one, so rows ingested mid-export are consistently excluded.\n" +
    "\n" +
    "--format json: {device, window, asOf, values, points, readings}. --format csv is LONG, one\n" +
    "row per reading, with the point's logical path and unit. --out writes the payload (or the\n" +
    "CSV) to a file and prints only a summary.",
  args: [
    {
      name: "device",
      required: true,
      help: "A device: its dv_… id, integer handle, slug, or name",
    },
  ],
  flags: {
    ...BASE_URL_FLAG,
    since: {
      type: "string",
      required: true,
      placeholder: "ISO",
      help: "Window start, inclusive — an ISO instant with a zone",
    },
    until: {
      type: "string",
      required: true,
      placeholder: "ISO",
      help: "Window end, EXCLUSIVE — at most 7 days after --since",
    },
    point: {
      type: "string",
      repeatable: true,
      placeholder: "pt_…",
      help: "Only this point (repeatable)",
    },
    series: {
      type: "string",
      repeatable: true,
      placeholder: "glob",
      help: 'Only points whose logical path matches, e.g. "load/*" (repeatable; `*` does not cross `/`)',
    },
    out: {
      type: "string",
      placeholder: "path",
      help: "Write the full payload (or the CSV, under --format csv) here; print only a summary",
    },
  },
  formats: ["human", "json", "csv"],
  exitCodes: { 1: "no readings in the window" },
  examples: [
    "liveone device readings 1 --since=2026-09-17T09:21:00Z --until=2026-09-17T10:02:00Z --format=json --out=raw.json",
    "liveone device readings daylesford --since=2026-09-17T09:00:00Z --until=2026-09-17T10:00:00Z --series='battery/*'",
    "liveone device readings 14 --since=2026-09-17T09:00:00Z --until=2026-09-17T10:00:00Z --format=csv --out=gen.csv",
  ],
  uses: ["api"],
} satisfies CommandSpec;

// ── wire ────────────────────────────────────────────────────────────────────────────────────────

interface WireRawPoint {
  pointId: string;
  physicalPath: string;
  logicalPath: string | null;
  metricType: string;
  unit: string | null;
  name: string;
  transform: string | null;
  active: boolean;
}

interface WireRawReading {
  pointId: string;
  sessionId: string | null;
  measurementTime: string;
  receivedTime: string;
  createdAt: string;
  value: number | null;
  valueStr: string | null;
  error: string | null;
  dataQuality: string;
}

interface WireRawPage {
  window: { since: string; until: string };
  asOf: string;
  values: string;
  points: WireRawPoint[];
  readings: WireRawReading[];
  nextCursor: string | null;
}

interface ReadingsExport {
  device: { id: string; systemId: number; name: string };
  window: { since: string; until: string };
  asOf: string;
  values: string;
  points: WireRawPoint[];
  readings: WireRawReading[];
}

// ── rendering ───────────────────────────────────────────────────────────────────────────────────

function readingsCsv(b: ReadingsExport): string {
  const byId = new Map(b.points.map((p) => [p.pointId, p]));
  return toCsv(
    [
      "point_id",
      "logical_path",
      "physical_path",
      "unit",
      "measurement_time",
      "received_time",
      "created_at",
      "value",
      "value_str",
      "error",
      "data_quality",
      "session_id",
    ],
    b.readings.map((r) => {
      const p = byId.get(r.pointId);
      return [
        r.pointId,
        p?.logicalPath,
        p?.physicalPath,
        p?.unit,
        r.measurementTime,
        r.receivedTime,
        r.createdAt,
        r.value,
        r.valueStr,
        r.error,
        r.dataQuality,
        r.sessionId,
      ];
    }),
  );
}

function summary(b: ReadingsExport) {
  const perPoint = new Map<string, number>();
  for (const r of b.readings)
    perPoint.set(r.pointId, (perPoint.get(r.pointId) ?? 0) + 1);
  return {
    device: b.device,
    window: b.window,
    asOf: b.asOf,
    values: b.values,
    points: b.points.length,
    pointsWithReadings: perPoint.size,
    readings: b.readings.length,
    sessions: new Set(b.readings.map((r) => r.sessionId).filter(Boolean)).size,
  };
}

function renderSummary(b: ReadingsExport, out?: string): string {
  const s = summary(b);
  const lines = [
    `${b.device.name} (${b.device.id})  ${b.window.since} → ${b.window.until}`,
    `  ${s.readings.toLocaleString()} reading(s) across ${s.pointsWithReadings}/${s.points} point(s), ${s.sessions} session(s)`,
    `  asOf ${b.asOf} · values ${b.values}`,
  ];
  if (out) lines.push(`  wrote ${out}`);
  else if (b.readings.length)
    lines.push(
      "",
      "  pass --format json|csv (with --out) for the rows themselves",
    );
  return lines.join("\n");
}

// ── handler ─────────────────────────────────────────────────────────────────────────────────────

function instantFlag(ctx: Ctx, name: "since" | "until"): number {
  const raw = str(ctx, name)!;
  const ms = Date.parse(raw);
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(raw) || !Number.isFinite(ms))
    throw usage(
      `--${name}=${raw} is not an ISO instant with a zone`,
      "a zone-less time is a guess about which clock it was read off",
      `e.g. --${name}=2026-09-17T09:21:00Z`,
    );
  return ms;
}

export async function runReadings(ctx: Ctx): Promise<number> {
  const sinceMs = instantFlag(ctx, "since");
  const untilMs = instantFlag(ctx, "until");
  if (untilMs <= sinceMs)
    throw usage(
      "--until is not after --since",
      "the window is half-open: since <= t < until",
      "swap them, or widen the window",
    );
  if (untilMs - sinceMs > MAX_SPAN_MS)
    throw usage(
      "the window is longer than 7 days",
      "a raw export is bounded per request so one call cannot become a table dump",
      "split the span into windows of at most 7 days",
    );
  const out = str(ctx, "out");

  return withApiSession(ctx, async (s) => {
    const device = await resolveDevice(s, ctx.args[0]);
    const base = `/api/v4/devices/${encodeURIComponent(device.id!)}/readings`;
    const q = new URLSearchParams({
      since: new Date(sinceMs).toISOString(),
      until: new Date(untilMs).toISOString(),
    });
    for (const p of (ctx.flags.point as string[] | undefined) ?? [])
      q.append("point", p);
    for (const g of (ctx.flags.series as string[] | undefined) ?? [])
      q.append("series", g);

    const first = await s.get<WireRawPage>(`${base}?${q}`);
    const readings = [...first.readings];
    let cursor = first.nextCursor;
    let pages = 1;
    while (cursor) {
      const next = new URLSearchParams(q);
      next.set("asOf", first.asOf);
      next.set("cursor", cursor);
      const page = await s.get<WireRawPage>(`${base}?${next}`);
      readings.push(...page.readings);
      cursor = page.nextCursor;
      pages++;
      if (!ctx.quiet && pages % 10 === 0)
        ctx.note(`… ${readings.length.toLocaleString()} readings so far`);
    }

    const body: ReadingsExport = {
      device: {
        id: device.id!,
        systemId: device.legacySystemId,
        name: device.name,
      },
      window: first.window,
      asOf: first.asOf,
      values: first.values,
      points: first.points,
      readings,
    };

    if (out !== undefined) {
      fs.writeFileSync(
        out,
        ctx.format === "csv"
          ? readingsCsv(body)
          : JSON.stringify(body, null, 2) + "\n",
      );
      ctx.emit(
        { ...summary(body), out },
        () => renderSummary(body, out),
        () => toCsv(["out", "readings"], [[out, readings.length]]),
      );
    } else {
      ctx.emit(
        body,
        () => renderSummary(body),
        () => readingsCsv(body),
      );
    }
    return readings.length ? EXIT.OK : EXIT.FINDINGS;
  });
}
