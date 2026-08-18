#!/usr/bin/env tsx
/**
 * Record this sync run as one tick on today's Slack row — the I/O half of slack-daily-row.ts.
 *
 * WHY: the sync used to post a separate incoming-webhook message per noteworthy event (recovered
 * dropouts, over-target duration, failure, timeout, first-success-after-unhealthy). At 12 runs/day
 * that is a wall of near-identical messages. The 2-hourly PG backups already solved this — one
 * message per job per day, edited in place (the-gitfather's scripts/lib/slack.ts) — so this does
 * the same, into the same channel with the same bot token. An incoming webhook can only post,
 * never edit, which is why the transport moved to chat.postMessage + chat.update.
 *
 * Called ONCE per run, as the workflow's last step, with `if: always()` so a failed or timed-out
 * run still ticks (a timeout must read as ❌, not as a missing run).
 *
 * Everything here is FAIL-SOFT: Slack must never decide the sync's fate. Every path exits 0.
 *
 * Env (all supplied by .github/workflows/sync-prod-to-dev.yml):
 *   SLACK_BOT_TOKEN / SLACK_CHANNEL              same pair pg-backup.yml passes to the-gitfather
 *   KV_REST_API_URL / KV_REST_API_TOKEN          day-state store (dev:sync-status:<YYYY-MM-DD>)
 *   JOB_STATUS                                   ${{ job.status }} — success | failure | cancelled
 *   SYNC_START                                   epoch seconds, stamped by the "Mark sync start" step
 *   SYNC_CONNECTION_DROPOUT_COUNT / _STAGES      recovered-dropout counters (run-workflow-step-with-diagnostics)
 *   SYNC_FAILURE_STAGE / _MODE / _DETAIL         failure classification (same wrapper)
 *   GITHUB_TOKEN + the standard GITHUB_* context
 */
import { kv, kvKey } from "@/lib/kv";
import {
  dailyHeader,
  dailyLabel,
  dateKeyFor,
  formatDuration,
  renderDailyText,
  type DailySyncEntry,
  type DailySyncState,
  type SyncStatus,
} from "./slack-daily-row";

/** Over this many seconds the sync is "over target" and the tick turns ⚠️. */
const TARGET_SECONDS = 300;

/** Keep a week of day-rows; long enough to re-read a past day, short enough to self-clean. */
const STATE_TTL_SECONDS = 7 * 24 * 60 * 60;

const env = (name: string): string => process.env[name]?.trim() ?? "";

function warn(message: string): void {
  process.stderr.write(`slack-daily: ${message}\n`);
}

// ── Slack Web API (fetch, never throws) ──────────────────────────────────────

async function slackApi(
  method: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("SLACK_BOT_TOKEN")}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    return { ok: body.ok === true, body };
  } catch (error) {
    warn(`${method} threw: ${String(error)}`);
    return { ok: false, body: {} };
  } finally {
    clearTimeout(timer);
  }
}

/** Post a message; returns its ts ("" on failure). `thread` replies under the day row. */
async function slackPost(
  text: string,
  opts: { thread?: string; broadcast?: boolean } = {},
): Promise<string> {
  const payload: Record<string, unknown> = {
    channel: env("SLACK_CHANNEL"),
    text,
    unfurl_links: false,
    unfurl_media: false,
  };
  if (opts.thread) {
    payload.thread_ts = opts.thread;
    payload.reply_broadcast = opts.broadcast ?? false;
  }
  const resp = await slackApi("chat.postMessage", payload);
  if (!resp.ok) {
    warn(`chat.postMessage failed: ${String(resp.body.error ?? "?")}`);
    return "";
  }
  return typeof resp.body.ts === "string" ? resp.body.ts : "";
}

async function slackUpdate(ts: string, text: string): Promise<boolean> {
  const resp = await slackApi("chat.update", {
    channel: env("SLACK_CHANNEL"),
    ts,
    text,
    unfurl_links: false,
    unfurl_media: false,
  });
  if (!resp.ok) warn(`chat.update failed: ${String(resp.body.error ?? "?")}`);
  return resp.ok;
}

// ── This run's tick ──────────────────────────────────────────────────────────

/** The run page — always available from the context, and the fallback when the jobs API doesn't answer. */
function runUrl(): string {
  const server = env("GITHUB_SERVER_URL") || "https://github.com";
  return `${server}/${env("GITHUB_REPOSITORY")}/actions/runs/${env("GITHUB_RUN_ID")}`;
}

/**
 * The log page for THIS job (…/actions/runs/<run>/job/<job>), so a timestamp in Slack deep-links
 * straight to the log rather than the run summary. Needs `permissions: actions: read` (already
 * granted). Any hiccup falls back to the run URL — a slightly-less-precise link is not worth a warning.
 */
async function jobLogUrl(): Promise<string> {
  const token = env("GITHUB_TOKEN");
  const repo = env("GITHUB_REPOSITORY");
  const runId = env("GITHUB_RUN_ID");
  if (!token || !repo || !runId) return runUrl();
  const api = env("GITHUB_API_URL") || "https://api.github.com";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(
      `${api}/repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: controller.signal,
      },
    );
    const body = (await res.json()) as {
      jobs?: { name?: string; html_url?: string }[];
    };
    const jobs = body.jobs ?? [];
    const mine = jobs.find((j) => j.name === env("GITHUB_JOB")) ?? jobs[0];
    return mine?.html_url || runUrl();
  } catch {
    return runUrl();
  } finally {
    clearTimeout(timer);
  }
}

interface RunOutcome {
  entry: DailySyncEntry;
  /** Loud text for the threaded alert, or "" when the run needs no alert. */
  alert: string;
}

/**
 * Fold the workflow's own env into one tick: glyph + "(duration, why)". The dropout counters and
 * failure classification already exist (run-workflow-step-with-diagnostics.ts writes them to
 * GITHUB_ENV) — this only consumes them.
 */
export function describeRun(
  now: Date,
  url: string,
  source: Record<string, string | undefined> = process.env,
): RunOutcome {
  const get = (name: string): string => source[name]?.trim() ?? "";
  const startedAt = Number(get("SYNC_START"));
  const elapsed =
    Number.isFinite(startedAt) && startedAt > 0
      ? Math.max(0, Math.floor(now.getTime() / 1000) - startedAt)
      : NaN;
  const duration = Number.isNaN(elapsed) ? "" : formatDuration(elapsed);

  const jobStatus = get("JOB_STATUS") || "success";
  const dropouts = Number(get("SYNC_CONNECTION_DROPOUT_COUNT") || 0) || 0;
  const notes: string[] = [];
  let status: SyncStatus = "ok";
  let alert = "";

  if (jobStatus === "cancelled") {
    status = "fail";
    notes.push("timed out");
    alert = `🔴 sync prod→dev TIMED OUT — liveone-dev may be stale. ${url}`;
  } else if (jobStatus !== "success") {
    status = "fail";
    const stage = get("SYNC_FAILURE_STAGE") || "workflow setup";
    const mode = get("SYNC_FAILURE_MODE") || "unclassified failure";
    const detail =
      get("SYNC_FAILURE_DETAIL") || "inspect the linked Actions log";
    notes.push(`${stage}: ${mode}`);
    alert = `🔴 sync prod→dev FAILED at ${stage}: ${mode} — ${detail}. liveone-dev may be stale. ${url}`;
  } else {
    // A clean run that recovered from dropouts, or blew the 5-min target, is still worth seeing —
    // but as ⚠️ on the row, not as its own message. That fold is the point of the daily row.
    if (dropouts > 0) {
      status = "warn";
      notes.push(`${dropouts} recovered`);
    }
    if (!Number.isNaN(elapsed) && elapsed > TARGET_SECONDS) {
      status = "warn";
      notes.push("over target");
    }
  }

  return {
    entry: {
      label: dailyLabel(now),
      status,
      detail: [duration, ...notes].filter(Boolean).join(", "),
      url,
      manual: get("GITHUB_EVENT_NAME") === "workflow_dispatch",
    },
    alert,
  };
}

// ── Day state (Vercel KV) ────────────────────────────────────────────────────

const stateKey = (dateKey: string): string => kvKey(`sync-status:${dateKey}`);

/**
 * Today's state, or null when KV could not be read — in which case we SKIP Slack entirely rather
 * than guess. A missing tick is benign; a second message for the same day is not.
 */
async function loadDaily(dateKey: string): Promise<DailySyncState | null> {
  try {
    const stored = (await kv.get(stateKey(dateKey))) as DailySyncState | null;
    if (stored && Array.isArray(stored.entries)) return stored;
    return { channel: "", ts: "", date: dateKey, header: "", entries: [] };
  } catch (error) {
    warn(
      `could not read today's state from KV (${String(error)}) — skipping Slack this run`,
    );
    return null;
  }
}

async function saveDaily(state: DailySyncState): Promise<void> {
  try {
    await kv.set(stateKey(state.date), state, { ex: STATE_TTL_SECONDS });
  } catch (error) {
    warn(`could not save today's state to KV: ${String(error)}`);
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!env("SLACK_BOT_TOKEN") || !env("SLACK_CHANNEL")) {
    console.log(
      "SLACK_BOT_TOKEN/SLACK_CHANNEL unset — skipping the Slack daily row",
    );
    return;
  }
  // The lib/kv.ts client silently no-ops when its credentials are missing, and a no-op get is
  // indistinguishable from "no state today" — which would post a fresh message every single run.
  if (!env("KV_REST_API_URL") || !env("KV_REST_API_TOKEN")) {
    warn(
      "KV credentials unset — skipping the Slack daily row (state would be unreadable)",
    );
    return;
  }

  const now = new Date();
  const dateKey = dateKeyFor(now);
  const url = await jobLogUrl();
  const { entry, alert } = describeRun(now, url);

  const state = await loadDaily(dateKey);
  if (!state) return;

  state.date = dateKey;
  // Recompute the header every persist so a wording change relinks the day's existing message.
  state.header = dailyHeader(now);
  state.entries = state.entries
    .filter((e) => e.label !== entry.label)
    .concat([entry]);

  const text = renderDailyText(state, now);
  if (state.ts) {
    if (!(await slackUpdate(state.ts, text))) return; // leave state alone; next run retries
  } else {
    const ts = await slackPost(text);
    if (!ts) {
      warn("could not post today's daily row");
      return;
    }
    state.ts = ts;
    state.channel = env("SLACK_CHANNEL");
  }
  await saveDaily(state);

  // A failure still gets a loud, mentioning message — but threaded under the day row, so the
  // channel keeps one message per day (matches how pg-backup threads its failure alert).
  if (alert) {
    await slackPost(`<!here> ${alert}`, { thread: state.ts, broadcast: true });
  }
  console.log(
    `slack-daily: recorded ${entry.status} ${entry.label} (${entry.detail})`,
  );
}

if (require.main === module) {
  void main()
    .catch((error) => {
      warn(`unexpected error: ${String(error)}`);
    })
    .finally(() => {
      // Never fail the sync over a notification.
      process.exitCode = 0;
    });
}
