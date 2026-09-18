/**
 * `liveone device diagnostics` and `liveone device events` — the retained fault record.
 *
 * ## Why this exists
 *
 * Over the three Daylesford power interruptions of 17–18 September 2026, every one of 126
 * successful minutely Selectronic samples reported `fault_code: 0`. The faults that explained the
 * outages — code 50 Instant Low DC Voltage, code 127 Main DC Supply Cable Open Circuit — existed
 * only in two places nothing retained: the Select.live Events page, and the inverter's own internal
 * logs. They were recovered by hand, afterwards, with throwaway scripts.
 *
 * So there are two sources and they are kept SEPARATE, labelled, and never merged:
 *
 *   portal    the Select.live Events page: code, description, Created and Cleared
 *   inverter  the SP LINK connection: code, the inverter's own timestamp, and an electrical
 *             snapshot, from two logs — `alert` (faults) and `operational` (state changes)
 *
 * Their codes overlap and their clocks do not agree. On 18 September the portal displayed a low-DC
 * clearance at 12:12:59 while the inverter recorded 12:02:12 on its own clock, measured ~46 s slow.
 * Collapsing them into one timeline would assert something neither source supports.
 *
 * A third dataset, the inverter's 15-minute MEASUREMENT history, is deliberately not here at all —
 * that is `selectlive history download`.
 *
 * ## `run` does not dial the inverter
 *
 * It enqueues a job; the minutely worker performs the acquisition. That indirection is the design:
 * the inverter permits one SP LINK session, so a manual request and an automatic trigger have to
 * coalesce rather than race. `run` returns immediately and `list` shows the pending job.
 */
import { EXIT, type CommandSpec, type Ctx } from "@/lib/cli/cli";
import { withApiSession, type ApiSession } from "@/lib/cli-kit/api-session";
import { apiFetch } from "@/lib/cli-kit/http";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { BASE_URL_FLAG, resolveDevice, str, type WireDevice } from "../shared";

const DEVICE_ARG = {
  name: "device",
  required: true,
  help: "A device: its dv_… id, integer handle, slug, or name",
} as const;

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

export const diagnosticsSpec = {
  name: "diagnostics",
  summary:
    "Captures of the inverter's internal event logs — list them, read one, export one, ask for another.",
  when:
    "Reach for this after an outage or an unexplained fault, when the ordinary readings say nothing.\n" +
    "`fault_code: 0` on every sample of an interruption is the normal case, not the reassuring one.",
  description:
    "A capture is the raw record stream read over the SP LINK connection, plus the metadata needed to\n" +
    "judge it: before/after ring descriptors, anchor stability, the device clock and its offset from\n" +
    "ours, and the scaling factors READ from the inverter. The decoded events land in\n" +
    "`liveone device events`; the capture is the evidence behind them.",
  subcommands: {
    list: {
      name: "list",
      summary:
        "Captures for a device, newest first, and any pending acquisition.",
      description:
        "`openJob` is reported alongside: 'nothing captured yet' and 'a capture has been pending for\n" +
        "six hours because the inverter is unreachable' look identical otherwise.",
      args: [DEVICE_ARG],
      flags: {
        ...BASE_URL_FLAG,
        limit: {
          type: "number",
          help: "Maximum captures to list (default 50)",
        },
      },
      examples: [
        "liveone device diagnostics list daylesford",
        "liveone device diagnostics list 1 --format json",
      ],
    },
    show: {
      name: "show",
      summary: "One capture in full, including its raw record stream.",
      args: [
        DEVICE_ARG,
        {
          name: "capture-id",
          required: true,
          help: "A capture uuid from `list`",
        },
      ],
      flags: { ...BASE_URL_FLAG },
      examples: ["liveone device diagnostics show daylesford 0192f0ab-…"],
    },
    export: {
      name: "export",
      summary:
        "Write a capture to a fresh directory: manifest, decoded CSV, raw records, checksums.",
      localEffects:
        "Creates a new directory under --out. Nothing existing is overwritten and nothing is sent anywhere.",
      description:
        "The raw records go out beside the decoding, on purpose: an export carrying only our reading\n" +
        "of the bytes would be unverifiable and could never be re-decoded.\n" +
        "\n" +
        "No destination is hardcoded. Incident bundles belong in the hac-admin knowledgebase, and\n" +
        "this repository is public — naming a private path here would publish it.",
      args: [
        DEVICE_ARG,
        {
          name: "capture-id",
          required: true,
          help: "A capture uuid from `list`",
        },
      ],
      flags: {
        ...BASE_URL_FLAG,
        out: {
          type: "string",
          required: true,
          help: "Parent directory for the new export",
        },
      },
      examples: [
        "liveone device diagnostics export daylesford 0192f0ab-… --out ./exports",
      ],
    },
    run: {
      name: "run",
      summary: "Ask for a fresh acquisition of the inverter's event logs.",
      when:
        "Use this when you want to look inside the inverter NOW — after an outage, or to verify the\n" +
        "acquisition path before enabling automatic triggers.",
      description:
        "🛑 Enqueues a job; it does NOT open the connection itself. The minutely diagnostics worker\n" +
        "performs the acquisition within about a minute, and `list` shows the job until it does.\n" +
        "That indirection is deliberate: the inverter permits one SP LINK session, so a manual\n" +
        "request must coalesce with an automatic trigger rather than race it. If an acquisition is\n" +
        "already open for this device, this joins it and says so.\n" +
        "\n" +
        "Read-only at the inverter: no setting is changed, no fault is reset, no generator command\n" +
        "is issued.",
      mutates: true,
      args: [DEVICE_ARG],
      flags: {
        ...BASE_URL_FLAG,
        reason: { type: "string", help: "Why — recorded with the job" },
      },
      examples: [
        "liveone device diagnostics run daylesford",
        'liveone device diagnostics run daylesford --reason "blackout 18 Sept" --apply',
      ],
    },
  },
} satisfies CommandSpec;

export const eventsSpec = {
  name: "events",
  summary:
    "The device's retained fault history, from the portal and from the inverter itself.",
  when:
    "Reach for this to find out what the equipment recorded around a time of interest — especially\n" +
    "when the ordinary readings show nothing.",
  description:
    "Two sources, LABELLED and never merged: `portal` (the Select.live Events page — code,\n" +
    "description, Created/Cleared) and `inverter` (its own alert and operational logs — code, the\n" +
    "inverter's clock, and an electrical snapshot). Their codes overlap and their clocks do not\n" +
    "agree, so a row's `source` is load-bearing, not decoration.\n" +
    "\n" +
    "Times are the ORIGINAL source text plus our UTC interpretation. A blank interpretation means\n" +
    "the source timestamp was ambiguous (a DST fold) or unreadable; the text is still there.",
  args: [DEVICE_ARG],
  flags: {
    ...BASE_URL_FLAG,
    source: {
      type: "string",
      help: "Only one source (default: both)",
      values: ["portal", "inverter"],
    },
    since: {
      type: "string",
      help: "ISO timestamp — only events at or after this",
    },
    until: {
      type: "string",
      help: "ISO timestamp — only events at or before this",
    },
    limit: { type: "number", help: "Maximum events (default 200)" },
  },
  formats: ["human", "json", "csv"],
  examples: [
    "liveone device events daylesford",
    "liveone device events daylesford --source inverter --since 2026-09-17T09:00:00Z",
    "liveone device events daylesford --format csv > events.csv",
  ],
} satisfies CommandSpec;

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

interface WireCaptureSummary {
  id: string;
  jobId: string | null;
  startedAt: string;
  finishedAt: string | null;
  complete: boolean;
  recordCount: number;
  newRecordCount: number;
  decoderVersion: number;
  coverage: {
    supportedFormat?: boolean;
    lostOverlap?: string[];
    logs?: Record<
      string,
      { acquired: number; advertised: number; stoppedBecause: string }
    >;
  } | null;
  sha256: string | null;
  error: string | null;
}
interface WireOpenJob {
  id: string;
  status: string;
  attempts: number;
  requestedBy: string;
  nextAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  reasons: { kind: string; detail: string; observedAt: string }[];
}
interface WireEvent {
  id: string;
  source: "portal" | "inverter";
  logType: string | null;
  code: number;
  description: string | null;
  sourceTimeText: string;
  sourceTimezone: string | null;
  occurredAt: string | null;
  clearedTimeText: string | null;
  clearedAt: string | null;
  observedAt: string;
  snapshot: Record<string, unknown> | null;
  raw: string | null;
  dedupeKey: string;
  captureId: string | null;
}

const devicePath = (device: WireDevice) =>
  `/api/v4/devices/${encodeURIComponent(device.id!)}`;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function fetchCaptures(
  s: ApiSession,
  device: WireDevice,
  limit?: number,
) {
  const query = limit ? `?limit=${limit}` : "";
  return s.get<{ captures: WireCaptureSummary[]; openJob: WireOpenJob | null }>(
    `${devicePath(device)}/diagnostics${query}`,
  );
}

function describeJob(job: WireOpenJob): string {
  const reasons = job.reasons
    .map((r) => `      ${r.observedAt}  ${r.kind}: ${r.detail}`)
    .join("\n");
  return [
    `Pending acquisition ${job.id}`,
    `  status ${job.status}, attempt ${job.attempts}, requested by ${job.requestedBy}`,
    job.nextAttemptAt ? `  next attempt ${job.nextAttemptAt}` : "",
    job.lastError ? `  last error: ${job.lastError}` : "",
    reasons ? `  reasons:\n${reasons}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function describeCapture(c: WireCaptureSummary): string {
  const logs = Object.entries(c.coverage?.logs ?? {})
    .map(
      ([log, l]) =>
        `${log} ${l.acquired}/${l.advertised} (${l.stoppedBecause})`,
    )
    .join(", ");
  const lost = c.coverage?.lostOverlap?.length
    ? `  🛑 overlap LOST for ${c.coverage.lostOverlap.join(", ")} — records were overwritten between captures`
    : "";
  return [
    `${c.startedAt}  ${c.id}`,
    `  ${c.complete ? "complete" : "INCOMPLETE"}, ${c.recordCount} records (${c.newRecordCount} new)${logs ? ` — ${logs}` : ""}`,
    lost,
    c.error ? `  error: ${c.error}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function runList(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const device = await resolveDevice(s, ctx.args[0]);
    const limit = Number(str(ctx, "limit") ?? "") || undefined;
    const body = await fetchCaptures(s, device, limit);
    ctx.emit(body, (m) => {
      const model = m as typeof body;
      const lines: string[] = [];
      if (model.openJob) lines.push(describeJob(model.openJob), "");
      if (!model.captures.length) lines.push("No captures.");
      else lines.push(...model.captures.map(describeCapture));
      return lines.join("\n");
    });
    // An incomplete newest capture, or a job that has been retrying, is a finding: the acquisition
    // path is not currently working, and nothing else reports that.
    const newest = body.captures[0];
    return (newest && !newest.complete) || (body.openJob?.attempts ?? 0) > 1
      ? EXIT.FINDINGS
      : EXIT.OK;
  });
}

async function fetchCapture(s: ApiSession, device: WireDevice, id: string) {
  const { capture } = await s.get<{ capture: Record<string, unknown> }>(
    `${devicePath(device)}/diagnostics/${encodeURIComponent(id)}`,
  );
  return capture;
}

async function runShow(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const device = await resolveDevice(s, ctx.args[0]);
    const capture = await fetchCapture(s, device, ctx.args[1]);
    ctx.emit(capture, (m) => JSON.stringify(m, null, 2));
    return capture.complete ? EXIT.OK : EXIT.FINDINGS;
  });
}

const csvCell = (v: unknown) =>
  v == null ? "" : `"${String(v).replace(/"/g, '""')}"`;

const EVENT_CSV_COLUMNS = [
  "source",
  "logType",
  "sourceTimeText",
  "occurredAt",
  "code",
  "description",
  "clearedTimeText",
  "clearedAt",
  "observedAt",
  "dedupeKey",
] as const;

const eventsCsv = (events: WireEvent[]) =>
  [
    EVENT_CSV_COLUMNS.join(","),
    ...events.map((e) =>
      EVENT_CSV_COLUMNS.map((c) => csvCell(e[c as keyof WireEvent])).join(","),
    ),
  ].join("\n");

async function runExport(ctx: Ctx): Promise<number> {
  const out = str(ctx, "out")!;
  return withApiSession(ctx, async (s) => {
    const device = await resolveDevice(s, ctx.args[0]);
    const captureId = ctx.args[1];
    const capture = await fetchCapture(s, device, captureId);
    // 🛑 Filtered by the SERVER, on `capture`. Fetching the device's newest 2000 events and
    // filtering here silently exported an empty CSV for any capture old enough to have fallen off
    // that page — and returned success while doing it.
    const events = (
      await s.get<{ events: WireEvent[] }>(
        `${devicePath(device)}/events?capture=${encodeURIComponent(captureId)}`,
      )
    ).events;

    fs.mkdirSync(path.resolve(out), { recursive: true });
    const directory = fs.mkdtempSync(
      path.join(path.resolve(out), `diagnostics-${device.id}-`),
    );
    const files: Record<string, { sha256: string; bytes: number }> = {};
    const write = (name: string, body: string) => {
      fs.writeFileSync(path.join(directory, name), body, {
        flag: "wx",
        mode: 0o600,
      });
      files[name] = {
        sha256: createHash("sha256").update(body).digest("hex"),
        bytes: Buffer.byteLength(body),
      };
    };
    write("capture.json", JSON.stringify(capture, null, 2) + "\n");
    write(
      "records.jsonl",
      ((capture.raw as unknown[]) ?? [])
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    write("events.csv", eventsCsv(events) + "\n");
    write(
      "README.md",
      [
        `# Diagnostic capture ${captureId}`,
        "",
        `Device: ${device.name ?? device.id} (${device.id})`,
        `Started: ${capture.startedAt}   Finished: ${capture.finishedAt ?? "—"}`,
        `Complete: ${capture.complete}   Decoder version: ${capture.decoderVersion}`,
        "",
        "## What is here",
        "",
        "- `capture.json` — the capture row in full: identity, ring metadata before and after the",
        "  walk, the scaling factors read from the inverter, the device clock and its offset from",
        "  ours, and the raw record stream.",
        "- `records.jsonl` — the raw records alone, one per line (`{log, address, hex}`).",
        "- `events.csv` — the decoded events this capture produced.",
        "- `checksums.json` — SHA-256 of each file above.",
        "",
        "## Reading the times",
        "",
        "Every event timestamp is the INVERTER's own clock, stored verbatim. `clock.offsetSeconds`",
        "in `capture.json` is how far that clock was from ours at the moment of the capture; it is",
        "an observation, and it has NOT been applied to any timestamp here.",
        "",
        "Portal (Select.live Events page) times are a different clock and are not in this file.",
        "",
        "## Provenance",
        "",
        "Read-only acquisition over the Select.live SP LINK tunnel. No setting was changed, no fault",
        "was reset and no generator command was issued.",
        "",
      ].join("\n"),
    );
    write("checksums.json", JSON.stringify(files, null, 2) + "\n");

    ctx.emit(
      { directory, captureId, events: events.length, files },
      () =>
        `Exported capture ${captureId} to ${directory}\n` +
        `  ${events.length} decoded events, ${((capture.raw as unknown[]) ?? []).length} raw records`,
    );
    return EXIT.OK;
  });
}

async function runRun(ctx: Ctx): Promise<number> {
  return withApiSession(
    ctx,
    async (s) => {
      const device = await resolveDevice(s, ctx.args[0]);
      const reason = str(ctx, "reason");
      let result: { jobId?: string; coalesced?: boolean } = {};
      if (!ctx.dryRun) {
        result = (
          await apiFetch(s.origin, `${devicePath(device)}/diagnostics`, {
            method: "POST",
            token: s.token,
            body: reason ? { reason } : {},
          })
        ).body as { jobId?: string; coalesced?: boolean };
      }
      ctx.emit(
        { device: device.id, reason, applied: !ctx.dryRun, ...result },
        () =>
          ctx.dryRun
            ? `would request a diagnostic acquisition for ${device.name ?? device.id}.\n` +
              "Re-run with --apply to enqueue it."
            : `Requested: job ${result.jobId}${result.coalesced ? " (joined an acquisition already open for this device)" : ""}.\n` +
              "The minutely worker performs it; `liveone device diagnostics list` shows the job until it does.",
      );
      return EXIT.OK;
    },
    ctx.dryRun ? "dry-run" : "APPLY",
  );
}

export async function runEvents(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const device = await resolveDevice(s, ctx.args[0]);
    const query = new URLSearchParams();
    for (const [flag, key] of [
      ["source", "source"],
      ["since", "since"],
      ["until", "until"],
      ["limit", "limit"],
    ] as const) {
      const value = str(ctx, flag);
      if (value) query.set(key, value);
    }
    const suffix = query.toString() ? `?${query}` : "";
    const { events } = await s.get<{ events: WireEvent[] }>(
      `${devicePath(device)}/events${suffix}`,
    );
    ctx.emit(
      { device: device.id, events },
      (m) => {
        const rows = (m as { events: WireEvent[] }).events;
        if (!rows.length) return "No events.";
        return rows
          .map((e) => {
            const where =
              e.source === "inverter" ? `inverter/${e.logType}` : "portal";
            const cleared = e.clearedTimeText
              ? `  cleared ${e.clearedTimeText}`
              : e.source === "portal"
                ? "  ACTIVE"
                : "";
            return `${e.sourceTimeText}  ${where.padEnd(22)} ${String(e.code).padStart(4)}  ${e.description ?? ""}${cleared}`;
          })
          .join("\n");
      },
      (m) => eventsCsv((m as { events: WireEvent[] }).events),
    );
    return events.length ? EXIT.OK : EXIT.FINDINGS;
  });
}

export const DIAGNOSTICS_HANDLERS: Record<
  string,
  (ctx: Ctx) => Promise<number>
> = {
  "diagnostics.list": runList,
  "diagnostics.show": runShow,
  "diagnostics.export": runExport,
  "diagnostics.run": runRun,
  events: runEvents,
};
