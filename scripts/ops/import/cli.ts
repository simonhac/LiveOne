/**
 * The `import` verb of the `liveone` CLI — write readings you supply into a device's serving store.
 *
 * A COMPOSABLE module (spec + dispatcher, no entrypoint), mounted by `scripts/ops/liveone.ts`.
 *
 * The manual sibling of `sync`. `sync` re-asks the VENDOR, and is the right answer whenever the
 * vendor still holds the window — it needs no file, cannot be mistyped, and arrives graded `good`
 * because it is a measurement. This verb is for the case `sync` cannot serve at all: a value no
 * vendor will ever return again. The case it was built for is Sigenergy's EV / rest-of-house split,
 * which has no historical endpoint and is reconstructible only across holes of 15 minutes or less
 * (`lib/vendors/sigenergy/derive-power.ts`); past that a multi-hour outage leaves a hole that no
 * amount of re-fetching will close.
 *
 * 🛑 **`--quality` is required, and choosing it is the whole job.** It is the only column that tells
 * a later reader whether a number was measured or reconstructed, and every consumer — the charts'
 * broken lines, the Sankey's "% estimated" chip, `isSettledQuality` — reads it. There is no default
 * on purpose: `good` would launder a reconstruction into a measurement, and `interpolated` would
 * defame a genuine measurement recovered from an export. Grade the CONFIDENCE in the number, not
 * the route it arrived by — `derive-power.ts` writes the vendor's own late-arriving samples as
 * `good` for exactly this reason.
 *
 * 🛑 **An import is a WRITE to the serving store that no vendor will ever correct.** A sync can be
 * re-run and will overwrite itself from the source of truth; an import's source of truth is the
 * operator. So it is dry-run by default like every mutating verb, it prints the target line first,
 * and it reports what it would write PER POINT, because "1,272 rows" hides the mistake that
 * actually happens — the right row count against the wrong point.
 */
import fs from "node:fs";
import { defineCommand, EXIT, str, type Ctx } from "@/lib/cli/cli";
import { withApiSession, type ApiSession } from "@/lib/cli-kit/api-session";
import { apiFetch } from "@/lib/cli-kit/http";
import { KNOWN_QUALITIES } from "@/lib/data-quality";
import { BASE_URL_FLAG, resolveDevice, usage } from "../shared";

/**
 * Rows per request. Matches `MAX_ROWS` in the route; the CLI chunks so an operator's file size is
 * never a thing they have to know about.
 */
const CHUNK = 5000;

interface WireRow {
  point: string;
  intervalEnd: string;
  value: number | string;
}

interface WirePoint {
  id: string;
  logicalPath: string | null;
  metricType: string;
  unit: string;
  rows: number;
}

interface WireImport {
  device: { id: string; systemId: number };
  interval: "5m";
  quality: string;
  points: WirePoint[];
  rows: number;
  firstInterval: string;
  lastInterval: string;
  dryRun: boolean;
  written: number;
}

export const importCommand = defineCommand({
  name: "import",
  summary: "Write readings you supply into a device's 5-minute serving store.",
  when:
    "Use this ONLY for a value no vendor will return again. If the vendor still holds the window,\n" +
    "`liveone sync` is the right verb — it needs no file and its data arrives measured.\n" +
    "After an import, run `liveone device recompute` for the same days: nothing rebuilds a past\n" +
    "day's aggregates or flow matrix on its own.",
  description:
    "Admin/owner only, http-only. Prints `target: <origin> as <you>` on stderr first.\n\n" +
    "--file is a CSV with a header and three columns: point,interval_end,value.\n" +
    "  point         a pt_… id belonging to THIS device (any other is refused, whole-request)\n" +
    "  interval_end  ISO timestamp, on a 5-minute boundary, the interval's END\n" +
    "  value         a number, or a string for a text point\n" +
    "Use `-` to read the CSV from stdin.\n\n" +
    "--quality is REQUIRED and is the point of the verb: it is the only record of whether a number\n" +
    "was measured or reconstructed. Grade the confidence in the VALUE, not how it reached you.\n\n" +
    "Writes are an UPSERT on (point, interval_end), so re-running a corrected file is the intended\n" +
    "way to repair a bad import. Rows are chunked; a file of any size is one command.",
  uses: ["api"],
  args: [
    {
      name: "device",
      required: true,
      help: "A device: its dv_… id, integer handle, slug, or name",
    },
  ],
  flags: {
    ...BASE_URL_FLAG,
    file: {
      type: "string",
      placeholder: "path",
      help: "CSV of point,interval_end,value — or `-` for stdin",
    },
    quality: {
      type: "string",
      placeholder: "marker",
      values: [...KNOWN_QUALITIES],
      help: "REQUIRED — the data_quality to stamp on every row. `calculated` = exact by identity from a measured series; `interpolated` = a genuine guess of ours; `good` = a measurement.",
    },
  },
  mutates: true,
  examples: [
    "liveone import kutis --file=rows.csv --quality=interpolated",
    "liveone import kutis --file=rows.csv --quality=interpolated --apply",
    "liveone import 13 --file=- --quality=calculated --apply --yes",
  ],
  exitCodes: {
    1: "the file parsed but the server wrote fewer rows than it was sent",
  },
});

/**
 * Parse the long CSV. Deliberately strict and positional-by-header: a silently-misread column is
 * the failure mode that produces a plausible-looking import against the wrong point or the wrong
 * hour, which is exactly the thing nothing downstream can detect later.
 */
export function parseCsv(text: string): WireRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length === 0)
    throw usage(
      "the file is empty",
      "there is nothing to import",
      "check the path",
    );

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const want = ["point", "interval_end", "value"];
  const idx = want.map((w) => header.indexOf(w));
  const missing = want.filter((w, i) => idx[i] === -1);
  if (missing.length > 0)
    throw usage(
      `the header is missing: ${missing.join(", ")}`,
      `found: ${header.join(", ")}`,
      "the first line must be a header naming point, interval_end and value",
    );

  const rows: WireRow[] = [];
  for (const [n, line] of lines.slice(1).entries()) {
    const cells = line.split(",").map((c) => c.trim());
    if (cells.length < header.length)
      throw usage(
        `line ${n + 2} has ${cells.length} column(s), expected ${header.length}`,
        "every row must match the header",
        "check for a stray comma, or quote the field that contains one",
      );
    const raw = cells[idx[2]];
    const num = Number(raw);
    rows.push({
      point: cells[idx[0]],
      intervalEnd: cells[idx[1]],
      // A bare empty cell is almost always a hole someone forgot to strip, not a value.
      value: raw === "" ? "" : Number.isFinite(num) && raw !== "" ? num : raw,
    });
  }
  if (rows.length === 0)
    throw usage(
      "the file has a header but no rows",
      "there is nothing to import",
      "check the file was written fully",
    );
  return rows;
}

async function post(
  s: ApiSession,
  path: string,
  body: unknown,
): Promise<WireImport> {
  const res = await apiFetch<WireImport>(s.origin, path, {
    method: "POST",
    body,
    token: s.token,
  });
  return res.body;
}

function render(r: WireImport, applied: boolean): string {
  const lines: string[] = [];
  lines.push(
    `${applied ? "imported" : "would import"}  ${r.rows} row(s)  quality=${r.quality}  interval=${r.interval}`,
  );
  lines.push(`window   ${r.firstInterval} .. ${r.lastInterval}`);
  for (const p of r.points)
    lines.push(
      `  ${p.id}  ${p.logicalPath ?? "(no logical path)"}  ${p.rows} row(s)  [${p.metricType}, ${p.unit}]`,
    );
  if (applied) lines.push(`written  ${r.written}`);
  else lines.push("dry run — nothing was written. Re-run with --apply.");
  return lines.join("\n");
}

export async function runImport(ctx: Ctx): Promise<number> {
  const ref = ctx.args[0];
  const file = str(ctx, "file");
  if (!file)
    throw usage(
      "--file is required",
      "an import needs rows to write",
      "--file=rows.csv, or --file=- to read the CSV from stdin",
    );
  // 🛑 No default. See the header: the marker is the one thing the caller must decide, and the
  // parser has already checked it against KNOWN_QUALITIES.
  const quality = str(ctx, "quality");
  if (!quality)
    throw usage(
      "--quality is required",
      "data_quality is the only record of whether these numbers were measured or reconstructed",
      `one of: ${KNOWN_QUALITIES.join(", ")}`,
    );

  const text =
    file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(file, "utf8");
  const rows = parseCsv(text);

  return withApiSession(
    ctx,
    async (s) => {
      const device = await resolveDevice(s, ref);
      if (!device.id)
        throw usage(
          `device ${ref} has no dv_ id on this origin`,
          "import addresses a device by its TypeID",
          "run `liveone device list` to see the ids this origin serves",
        );
      const path = `/api/v4/devices/${device.id}/import`;

      // The dry run goes to the SERVER: only it knows which points belong to this device and what
      // metric type each one is, and a local "would write N rows" would be confident and wrong the
      // moment a point was retired or re-minted.
      if (ctx.dryRun) {
        const first = await post(s, path, {
          interval: "5m",
          quality,
          readings: rows.slice(0, CHUNK),
          dryRun: true,
        });
        // Report the FULL file, not just the validated first chunk, so the number the operator
        // checks is the number they are about to write.
        const preview = {
          ...first,
          rows: rows.length,
          chunks: Math.ceil(rows.length / CHUNK),
        };
        ctx.emit(preview, () => render(preview, false));
        return EXIT.OK;
      }

      const results: WireImport[] = [];
      for (let i = 0; i < rows.length; i += CHUNK) {
        results.push(
          await post(s, path, {
            interval: "5m",
            quality,
            readings: rows.slice(i, i + CHUNK),
            dryRun: false,
          }),
        );
      }

      const written = results.reduce((n, r) => n + r.written, 0);
      const byPoint = new Map<string, WirePoint>();
      for (const r of results)
        for (const p of r.points) {
          const prev = byPoint.get(p.id);
          byPoint.set(p.id, prev ? { ...p, rows: prev.rows + p.rows } : p);
        }
      const merged: WireImport = {
        ...results[0],
        points: [...byPoint.values()],
        rows: rows.length,
        written,
        firstInterval: results.reduce(
          (a, r) => (r.firstInterval < a ? r.firstInterval : a),
          results[0].firstInterval,
        ),
        lastInterval: results.reduce(
          (a, r) => (r.lastInterval > a ? r.lastInterval : a),
          results[0].lastInterval,
        ),
      };

      ctx.emit(merged, () => render(merged, true));
      ctx.note(
        `next: liveone device recompute ${device.id} --start=<first local day> --end=<last local day> --apply`,
      );
      // A short write is not an error the server reported — every row it accepted, it wrote — but it
      // means rows collapsed on (point, interval_end), i.e. the file named the same interval twice.
      return written === rows.length ? EXIT.OK : EXIT.FINDINGS;
    },
    ctx.dryRun ? "dry-run" : "APPLY",
  );
}
