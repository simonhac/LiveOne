/**
 * The `sync` domain of the `liveone` CLI — re-fetch a historical window from a device's vendor.
 *
 * A COMPOSABLE module (spec + dispatcher, no entrypoint), mounted by `scripts/ops/liveone.ts`.
 *
 * 🛑 **This verb exists because "success" was a lie.** On 2026-09-09 a 64-day Amber backfill
 * reported `Rows inserted: 1008 / Success: YES` ten times in a row and materialised **zero** rows:
 * the number counted what the sync COMPARED, publishing is only the near end of an asynchronous
 * pipeline, and nothing anywhere read the serving store back. So this verb reports two separate
 * numbers and never conflates them — `published`, what went onto the wire, and `landed`, what a
 * subsequent READ of the serving store can actually see. A sync that reports success while its data
 * is unqueryable is worse than one that fails.
 *
 * Everything publishes on the **backfill** lane, so a multi-week replay cannot delay live minutely
 * ingest — the failure that started all of this.
 */
import { defineCommand, EXIT, type Ctx } from "@/lib/cli/cli";
import { withApiSession, type ApiSession } from "@/lib/cli-kit/api-session";
import { apiFetch } from "@/lib/cli-kit/http";
import { BASE_URL_FLAG, bool, resolveRef, str, usage } from "../shared";

interface WireDevice {
  id: string | null;
  legacySystemId: number;
  name: string;
  slug: string | null;
  vendor: string;
  vendorSiteId: string | null;
  status: string;
  ownerUserId: string | null;
}

/** One vendor window, as the route reports it. `observations` is PUBLISHED, never "inserted". */
export interface WireChunk {
  start: string;
  end: string;
  days: number;
  observations: number;
  merged: number;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface WireSync {
  device: { id: string; systemId: number; name: string; vendor: string };
  window: { start: string; end: string; days: number };
  action: string;
  dryRun: boolean;
  vendorMaxDays: number;
  lane: string;
  /** The windows the walk WOULD use — present on every response, computed without the vendor. */
  plan: Array<{ start: string; end: string; days: number }>;
  chunks: WireChunk[];
  observations: number;
  merged: number;
  failed: number;
  done: boolean;
  nextStart: string | null;
}

/** One series' extents, from `GET /api/history?…&listSeries=1` — the landing check's raw material. */
interface WireSeries {
  id: string;
  firstData?: string | null;
  lastData?: string | null;
  samples?: number | null;
}

const ACTIONS = ["usage", "pricing", "both"] as const;

/** `YYYY-MM-DD`, and a real date. The server re-checks; this names the flag that is wrong. */
function requireDay(ctx: Ctx, flag: string): string {
  const raw = str(ctx, flag);
  if (raw === undefined)
    throw usage(
      `--${flag} is required`,
      "a sync names an explicit window — there is no sensible default for how far back to refetch",
      `pass --${flag}=YYYY-MM-DD`,
    );
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw)))
    throw usage(
      `invalid --${flag} "${raw}"`,
      "the window is expressed in whole LOCAL days",
      `pass --${flag}=YYYY-MM-DD`,
    );
  return raw;
}

async function listDevices(s: ApiSession): Promise<WireDevice[]> {
  const { devices } = await s.get<{ devices: WireDevice[] }>("/api/v4/devices");
  return devices;
}

/**
 * Series extents for a device, used to measure what a sync actually LANDED.
 *
 * Deliberately the same read `liveone device history --list-series` serves, rather than a bespoke
 * count endpoint: the point of the landing check is that it goes through the ordinary serving path,
 * the one a dashboard would use. A count computed by the writer would only ever agree with itself.
 */
async function readSeries(
  s: ApiSession,
  deviceId: string,
): Promise<WireSeries[]> {
  const body = await s.get<{ series?: WireSeries[] }>(
    `/api/history?deviceId=${encodeURIComponent(deviceId)}&list=series`,
  );
  return body.series ?? [];
}

/** Series whose extent covers any part of `[start, end]` — the ones a window should have moved. */
function coveringCount(
  series: WireSeries[],
  start: string,
  end: string,
): number {
  return series.filter(
    (x) =>
      x.firstData != null &&
      x.lastData != null &&
      x.firstData.slice(0, 10) <= end &&
      x.lastData.slice(0, 10) >= start,
  ).length;
}

const ms = (n: number) => (n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`);

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export const syncCommand = defineCommand({
  name: "sync",
  summary:
    "Re-fetch a historical window from a device's vendor, on the backfill lane.",
  when:
    "Reach for this when a device is MISSING history a vendor still holds — a gap found by\n" +
    "`liveone device history --list-series`, or a device connected after the fact. For what the\n" +
    "ingest path is doing while it runs, use `liveone queue`.",
  description:
    "Admin/owner only, http-only. Prints `target: <origin> as <you>` on stderr first.\n\n" +
    'Reports PUBLISHED and LANDED as separate numbers, and never says "inserted". Publishing is\n' +
    "the near end of an asynchronous pipeline: on 2026-09-09 a backfill reported success ten times\n" +
    "while materialising zero rows. `landed` is a read of the serving store AFTER the lane drains,\n" +
    "through the same path a dashboard would use.\n\n" +
    "Chunked to the VENDOR's own window (Amber answers at most 7 days), so the caller passes the\n" +
    "range it wants and never a number the vendor imposed. Every message rides the `backfill` lane.",
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
    start: {
      type: "string",
      placeholder: "YYYY-MM-DD",
      help: "First local day to re-fetch (inclusive)",
    },
    end: {
      type: "string",
      placeholder: "YYYY-MM-DD",
      help: "Last local day to re-fetch (inclusive)",
    },
    action: {
      type: "string",
      placeholder: "action",
      values: [...ACTIONS],
      help: "Which half to fetch: usage (energy + cost), pricing (rates), or both (default: both). Prefer the narrowest that covers the gap.",
    },
    verify: {
      type: "boolean",
      // 🛑 `default: true`, DECLARED — not inferred from `undefined` in the handler. The parser
      // initialises an absent boolean to `false`, so a handler testing `=== undefined` tests a
      // state that never occurs and the check silently never runs. That shipped in the first cut
      // of this flag and cost the first real recovery its verification: the run reported "landed
      // not checked" and was right to, for the wrong reason. A check that quietly does not run is
      // the exact defect this verb exists to prevent.
      default: true,
      help: "After publishing, wait for the lane to drain and read the serving store back. --no-verify skips it, and the report then says the landing was NOT checked.",
    },
  },
  mutates: true,
  examples: [
    "liveone sync 10002 --start=2026-07-07 --end=2026-09-08 --action=usage",
    "liveone sync 10002 --start=2026-07-07 --end=2026-09-08 --action=usage --apply",
  ],
});

export async function runSync(ctx: Ctx): Promise<number> {
  const ref = ctx.args[0];
  const start = requireDay(ctx, "start");
  const end = requireDay(ctx, "end");
  if (end < start)
    throw usage(
      `--end (${end}) is before --start (${start})`,
      "the window is inclusive of both ends",
      "swap them",
    );
  const action = str(ctx, "action") ?? "both";
  if (!(ACTIONS as readonly string[]).includes(action))
    throw usage(
      `invalid --action "${action}"`,
      "a sync fetches usage, pricing, or both",
      `pass one of ${ACTIONS.join(", ")}`,
    );

  return withApiSession(
    ctx,
    async (s) => {
      const device = await resolveRef(await listDevices(s), ref, {
        noun: "device",
        listCmd: "liveone device list",
      });
      if (!device.id)
        throw usage(
          `device ${ref} has no dv_ id on this origin`,
          "sync addresses a device by its TypeID",
          "run `liveone device list` to see the ids this origin serves",
        );
      const path = `/api/v4/devices/${device.id}/sync`;

      // The dry run goes to the SERVER, not to a local guess: it is the only thing that knows the
      // vendor's window, whether credentials exist, and whether this device can be synced at all.
      // A local "would do N chunks" would be confident and wrong the moment any of that changed.
      const first = await post(s, path, {
        start,
        end,
        action,
        dryRun: ctx.dryRun,
      });

      if (ctx.dryRun) {
        ctx.emit(first, () => renderPlan(first));
        return EXIT.OK;
      }

      // Resume until the server says the window is finished. The budget is the SERVER's wall clock,
      // so the number of round trips depends on how slow the vendor is being, not on any count here.
      const runs: WireSync[] = [first];
      let cursor = first.nextStart;
      while (cursor && first.failed === 0) {
        const next = await post(s, path, {
          start: cursor,
          end,
          action,
          dryRun: false,
        });
        runs.push(next);
        if (next.failed > 0) break;
        cursor = next.nextStart;
      }

      const chunks = runs.flatMap((r) => r.chunks);
      const published = chunks.reduce((n, c) => n + c.observations, 0);
      const failed = chunks.filter((c) => !c.ok);
      const finished = runs[runs.length - 1].done && failed.length === 0;

      const landed = bool(ctx, "verify")
        ? await verifyLanded(s, device.id, start, end, published)
        : null;

      const result = {
        device: {
          id: device.id,
          systemId: device.legacySystemId,
          name: device.name,
        },
        window: { start, end },
        action,
        lane: "backfill",
        chunks,
        published,
        merged: chunks.reduce((n, c) => n + c.merged, 0),
        failed: failed.length,
        done: finished,
        landed,
      };
      ctx.emit(result, () => renderRun(result));

      // A finding, not an error: the command did its job and is reporting what it found.
      if (failed.length || !finished) return EXIT.FINDINGS;
      if (landed && landed.seriesCovering === 0 && published > 0)
        return EXIT.FINDINGS;
      return EXIT.OK;
    },
    ctx.dryRun ? "dry-run" : "APPLY",
  );
}

async function post(
  s: ApiSession,
  path: string,
  body: unknown,
): Promise<WireSync> {
  const { body: out } = await apiFetch<WireSync>(s.origin, path, {
    method: "POST",
    body,
    token: s.token,
    // This route reports refusals as `{ error }` — a sentence, not a code. The default 422 handler
    // builds a document-validator message from `{ errors[] }` and would discard it.
    errors: {
      422: (b: Record<string, unknown>) =>
        String(b.error ?? "the server refused this sync"),
    },
  });
  return out;
}

interface Landed {
  seriesCovering: number;
  seriesTotal: number;
  waitedMs: number;
  settled: boolean;
}

/**
 * Wait for the backfill lane to land what was published, then read the serving store back.
 *
 * 🛑 The wait is bounded and its outcome is REPORTED (`settled`), never assumed. "I stopped waiting"
 * and "nothing arrived" produce the same zero, and reporting the first as the second is precisely
 * the shape of the original defect.
 */
async function verifyLanded(
  s: ApiSession,
  deviceId: string,
  start: string,
  end: string,
  published: number,
): Promise<Landed> {
  const startedAt = Date.now();
  let series = await readSeries(s, deviceId);
  if (published === 0)
    return {
      seriesCovering: coveringCount(series, start, end),
      seriesTotal: series.length,
      waitedMs: 0,
      settled: true,
    };

  const deadline = startedAt + 120_000;
  for (;;) {
    const covering = coveringCount(series, start, end);
    const waitedMs = Date.now() - startedAt;
    if (covering > 0)
      return {
        seriesCovering: covering,
        seriesTotal: series.length,
        waitedMs,
        settled: true,
      };
    if (Date.now() >= deadline)
      return {
        seriesCovering: covering,
        seriesTotal: series.length,
        waitedMs,
        settled: false,
      };
    await new Promise((r) => setTimeout(r, 5000));
    series = await readSeries(s, deviceId);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderPlan(w: WireSync): string {
  // The boundaries come from the SERVER, not from arithmetic here: it is the only thing that knows
  // the vendor's window, and a local guess would be confident and wrong the day that changes.
  const n = w.plan.length;
  const out = [
    `device       ${w.device.systemId}  ${w.device.name}  (${w.device.vendor})`,
    `window       ${w.window.start} → ${w.window.end}   (${w.window.days} days)`,
    `action       ${w.action}`,
    `chunks       ${n} × ≤${w.vendorMaxDays} days  — the vendor's own limit`,
    `lane         ${w.lane}  — cannot delay live ingest`,
    "",
  ];
  for (const p of w.plan)
    out.push(
      `  ${p.start} → ${p.end}   (${p.days} day${p.days === 1 ? "" : "s"})`,
    );
  out.push(
    "",
    `would fetch and publish ${n} window(s). Nothing has been fetched or written.`,
    "(dry run — pass --apply to write)",
  );
  return out.join("\n");
}

interface RunResult {
  device: { id: string; systemId: number; name: string };
  window: { start: string; end: string };
  action: string;
  lane: string;
  chunks: WireChunk[];
  published: number;
  merged: number;
  failed: number;
  done: boolean;
  landed: Landed | null;
}

export function renderRun(r: RunResult): string {
  const out = [
    `device       ${r.device.systemId}  ${r.device.name}`,
    `window       ${r.window.start} → ${r.window.end}`,
    `action       ${r.action}   lane ${r.lane}`,
    "",
    "window                      days   published  merged  duration  outcome",
  ];
  for (const c of r.chunks)
    out.push(
      [
        `${c.start} → ${c.end}`.padEnd(26),
        String(c.days).padStart(4),
        String(c.observations).padStart(11),
        String(c.merged).padStart(7),
        ms(c.durationMs).padStart(9),
        "  " + (c.ok ? "ok" : `FAILED — ${c.error ?? "?"}`),
      ].join(" "),
    );

  out.push(
    "",
    `published    ${r.published} observations across ${r.chunks.length} window(s)`,
  );
  if (r.merged)
    // Amber is the only vendor that should ever report a non-zero here: its usage and pricing
    // fetches both carry the import rate, and the collector resolves the pair exactly as the store
    // would. A non-zero count anywhere else is the visible edge of a producer bug.
    out.push(
      `merged       ${r.merged} duplicate observations collapsed before publish`,
    );

  // 🛑 The two numbers stay apart. `published` is what went onto the wire; only `landed` says the
  // serving store can answer for it.
  if (r.landed === null)
    out.push(
      "landed       not checked (--no-verify) — published is NOT a landing claim",
    );
  else if (!r.landed.settled)
    out.push(
      `landed       UNKNOWN — waited ${ms(r.landed.waitedMs)} and no series covers the window yet.`,
      "             That is a timeout, NOT a measurement of zero. Re-read with",
      `             \`liveone device history ${r.device.systemId} --list-series\`.`,
    );
  else
    out.push(
      `landed       ${r.landed.seriesCovering} of ${r.landed.seriesTotal} series now cover the window` +
        (r.landed.waitedMs ? `  (after ${ms(r.landed.waitedMs)})` : ""),
    );

  if (r.failed)
    out.push(
      "",
      `${r.failed} window(s) FAILED — the walk stopped rather than repeating the error.`,
    );
  else if (!r.done)
    out.push(
      "",
      "The window is NOT finished — re-run to resume from where this stopped.",
    );
  return out.join("\n");
}
