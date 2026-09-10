import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { qstash } from "@/lib/qstash";
import { readMessageLog } from "@/lib/observations/message-log";
import {
  OBSERVATION_LANES,
  type ObservationLane,
} from "@/lib/observations/types";

/**
 * Per-message delivery timing for the observations ingest path — `liveone queue timing`.
 *
 * A sibling of `/api/v4/queue` rather than a field on it: that route answers "is ingest flowing
 * right now" and is polled during an incident, this one is a windowed forensic read that pages
 * through QStash. Keeping them apart means the cheap question stays cheap.
 *
 * 🛑 Read `duration` and `wait` as a PAIR. A long wait with a short duration is head-of-line
 * blocking — something ahead of this message held the slot. A long duration is this message's own
 * work. `lag` cannot tell them apart, which is how 2026-09-09 was misdiagnosed twice.
 *
 *   GET ?last=2h | ?from=<iso|ms>&to=<iso|ms>  [&lane=live|backfill]
 *
 * Admin only (`requireAdmin`), like its sibling. See docs/plans/ingest-head-of-line-hardening.md.
 */

export const maxDuration = 60;

const err = (message: string, status = 422) =>
  NextResponse.json({ error: message }, { status });

/** `90s` / `15m` / `2h` / `7d` → milliseconds. Null when it is not that grammar. */
function parseDuration(text: string): number | null {
  const m = /^(\d+)(s|m|h|d)$/.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (n <= 0) return null;
  const unit = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[
    m[2] as "s" | "m" | "h" | "d"
  ];
  return n * unit;
}

/** An ISO instant or epoch-ms. Null when neither. */
function parseInstant(text: string): number | null {
  if (/^\d+$/.test(text)) return Number(text);
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : ms;
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;
  if (!qstash)
    return NextResponse.json(
      { error: "QStash not configured" },
      { status: 503 },
    );

  const q = request.nextUrl.searchParams;
  const now = Date.now();

  let fromMs: number;
  let toMs = now;
  const last = q.get("last");
  const from = q.get("from");
  if (last !== null && from !== null)
    return err("pass either last, or from/to — not both");
  if (from !== null) {
    const parsed = parseInstant(from);
    if (parsed === null) return err(`from is not an instant: "${from}"`);
    fromMs = parsed;
    const to = q.get("to");
    if (to !== null) {
      const parsedTo = parseInstant(to);
      if (parsedTo === null) return err(`to is not an instant: "${to}"`);
      toMs = parsedTo;
    }
  } else {
    // Default deliberately short. This pages through QStash, and the overwhelmingly common use is
    // "what just happened" — a wide window by accident is a slow answer during an incident.
    const span = parseDuration(last ?? "1h");
    if (span === null)
      return err(`last must look like 90s / 15m / 2h / 7d — got "${last}"`);
    fromMs = now - span;
  }
  if (toMs <= fromMs) return err("the window ends before it starts");

  const laneParam = q.get("lane");
  let lane: ObservationLane | undefined;
  if (laneParam !== null && laneParam !== "all") {
    const found = OBSERVATION_LANES.find((l) => l === laneParam);
    if (!found)
      return err(`lane must be one of: ${OBSERVATION_LANES.join(", ")}, all`);
    lane = found;
  }

  try {
    return NextResponse.json(await readMessageLog({ fromMs, toMs, lane }));
  } catch (error) {
    // Degrade with a reason rather than a bare 500 — this is a view an operator reaches for when
    // things are already wrong, and "QStash would not answer" is itself the finding.
    console.error("[QueueLog] read failed:", error);
    return NextResponse.json(
      { error: `could not read the delivery log: ${String(error)}` },
      { status: 502 },
    );
  }
}
