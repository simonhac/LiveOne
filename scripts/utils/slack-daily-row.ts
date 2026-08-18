/**
 * Pure renderer for the sync-prod-to-dev daily Slack row — no I/O, no env, no Slack.
 *
 * One message per Sydney day, edited in place, one tick per 2-hourly run:
 *
 *   *sync prod→dev — Tue 18 Aug 2026 (AEST)*
 *   ✅ 00:20 (1m 21s)  ·  ⚠️ 04:20 (1m 21s, 2 recovered)  ·  ❌ 06:20 (5m 33s, …)  ·  ⬜ 08:00
 *
 * Ported from the-gitfather's scripts/lib/slack.ts (renderDailyText / dailyHeader / dailyLabel and
 * the 2-hourly slot math), which does the same job for the PG backups in the same channel — the
 * two rows deliberately share vocabulary and roll over on the same (Australia/Sydney) boundary.
 * Deliberately a PORT, not an import: that repo is a standalone engine consumed via a reusable
 * workflow, and its slack.ts is coupled to its own profile/rclone plumbing.
 *
 * The I/O half (Slack Web API, KV state, GitHub job URL) lives in report-sync-run-to-slack.ts;
 * everything here is a pure function of (state, now) so it can be table-tested.
 */

/** Rendering timezone. Matches pg-backup/liveone.yaml's `timezone:` so both daily rows roll over together. */
export const DISPLAY_TZ = "Australia/Sydney";

/** 2-hourly buckets per day; slot = floor(hour / 2). Drives the ⬜ "missed run" placeholders. */
export const SLOTS_PER_DAY = 12;

/** ✅ clean · ⚠️ completed but notable (recovered dropouts, over target) · ❌ failed or timed out. */
export type SyncStatus = "ok" | "warn" | "fail";

const GLYPH: Record<SyncStatus, string> = {
  ok: "✅",
  warn: "⚠️",
  fail: "❌",
};

export interface DailySyncEntry {
  /** "04:20" — the run's start time in DISPLAY_TZ. Also the identity of the entry (one per run). */
  label: string;
  status: SyncStatus;
  /** Parens body, already composed: "1m 21s, 2 recovered". Empty renders no parens. */
  detail: string;
  /** The run's job-log page; the label renders plain when absent. */
  url?: string;
  /** workflow_dispatch → 🖐️ prefix (parity with the backup rows). */
  manual?: boolean;
}

export interface DailySyncState {
  channel: string;
  ts: string;
  /** "YYYY-MM-DD" in DISPLAY_TZ — the day this message represents. */
  date: string;
  header: string;
  entries: DailySyncEntry[];
}

const pad2 = (n: number | string): string => String(n).padStart(2, "0");

const partsFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: DISPLAY_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
// C-locale-style abbreviations (en-US gives "Aug"/"Tue", matching bash `date +%b`/`%a`).
const headerDateFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_TZ,
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});
// en-AU, NOT en-US: only the AU locale knows "AEST"/"AEDT" — en-US renders "GMT+10"/"GMT+11".
const tzAbbrFmt = new Intl.DateTimeFormat("en-AU", {
  timeZone: DISPLAY_TZ,
  timeZoneName: "short",
});

interface TzParts {
  year: string;
  month: string;
  day: string;
  hour: number;
  minute: string;
}

function tzParts(now: Date): TzParts {
  const parts = partsFmt.formatToParts(now);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "00";
  const hh = get("hour") === "24" ? "00" : get("hour"); // h23 can still emit "24" on some ICU builds
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: Number(hh),
    minute: get("minute"),
  };
}

/** "58s" · "1m 21s" · "5m 33s" — the elapsed time inside the tick's parens. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${pad2(total % 60)}s`;
}

/** "HH:MM" in DISPLAY_TZ — the tick label, and the identity of a run's entry. */
export function dailyLabel(now: Date): string {
  const { hour, minute } = tzParts(now);
  return `${pad2(hour)}:${minute}`;
}

/** "YYYY-MM-DD" in DISPLAY_TZ — the state key and the day the message represents. */
export function dateKeyFor(now: Date): string {
  const { year, month, day } = tzParts(now);
  return `${year}-${month}-${day}`;
}

/**
 * "*sync prod→dev — Tue 18 Aug 2026 (AEST)*". Recomputed on every persist (not frozen at
 * creation) so a wording change relinks the existing day's message in place.
 */
export function dailyHeader(now: Date): string {
  const parts = headerDateFmt.formatToParts(now);
  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  const tz =
    tzAbbrFmt.formatToParts(now).find((p) => p.type === "timeZoneName")
      ?.value ?? "";
  return `*sync prod→dev — ${get("weekday")} ${get("day")} ${get("month")} ${get("year")} (${tz})*`;
}

const slotOf = (label: string): number =>
  Math.floor(Number(label.slice(0, 2)) / 2);

/**
 * Header + one tick per run, interleaved with ⬜ placeholders for elapsed-but-empty 2-hourly
 * buckets (so a skipped sync is visible), sorted by label and joined with " · ".
 *
 * Pure — `now` decides which buckets are "due". The +1h grace (2*slot + 1 <= hour) waits an hour
 * into a bucket before calling a tardy GitHub run missing.
 */
export function renderDailyText(state: DailySyncState, now: Date): string {
  const today = dateKeyFor(now);
  const currentHour = tzParts(now).hour;

  const filled = new Set(state.entries.map((e) => slotOf(e.label)));
  const placeholders: string[] = [];
  for (let slot = 0; slot < SLOTS_PER_DAY; slot++) {
    const due =
      state.date < today ||
      (state.date === today && 2 * slot + 1 <= currentHour);
    if (!due || filled.has(slot)) continue;
    placeholders.push(`${pad2(2 * slot)}:00`);
  }

  const ticks = state.entries.map((e) => {
    const prefix = e.manual ? "🖐️ " : "";
    const label = e.url ? `<${e.url}|${e.label}>` : e.label;
    const detail = e.detail ? ` (${e.detail})` : "";
    return {
      label: e.label,
      text: `${prefix}${GLYPH[e.status]} ${label}${detail}`,
    };
  });
  for (const label of placeholders) {
    ticks.push({ label, text: `⬜ ${label}` });
  }
  ticks.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

  return `${state.header}\n${ticks.map((t) => t.text).join("  ·  ")}`;
}
