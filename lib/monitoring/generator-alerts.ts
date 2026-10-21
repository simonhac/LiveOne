/**
 * Slack alerts for generator problems — the same list the tile's issues chip shows
 * (`assessGeneratorHealth`), pushed to someone who is not looking at the dashboard.
 *
 * Run from `/api/cron/monitor-observations` (every 15 min). Covers every area with an exercise rule:
 * a site that schedules unattended starts is the site that most needs to hear when they fail.
 *
 * 🛑 THROTTLED PER EPISODE, unlike the device-staleness alert beside it. The generator's problems
 * are slow — a flat battery stays flat until someone drives out to it — and an alert every 15 min
 * for three days is noise that teaches the reader to mute the channel. Each (area, issue, onset) is
 * sent once, then at most every {@link REPEAT_HOURS} while it persists; a NEW episode (a later
 * onset — the next missed slot, a battery that recovered and fell again) alerts at once.
 */
import { kv, kvKey } from "@/lib/kv";
import { sendAlert } from "@/lib/alerts";
import { listEnabled } from "@/lib/automations/store";
import { loadAreaForAuth } from "@/lib/areas/http";
import { loadGeneratorHealth } from "@/lib/control/generator-health-server";
import type {
  GeneratorIssue,
  GeneratorIssueCode,
} from "@/lib/control/generator-health";

const REPEAT_HOURS = 6;

/**
 * Which issues page. Every `critical`, plus `battery_low` — a battery off its charger was the one
 * warning, six hours before the October 2026 collapse, that could have saved the controller.
 */
const ALERTING: ReadonlySet<GeneratorIssueCode> = new Set([
  "controller_offline",
  "battery_flat",
  "battery_low",
  "exercise_failing",
  "exercise_missed",
]);

export interface GeneratorAlertSummary {
  areasChecked: number;
  issues: { area: string; code: GeneratorIssueCode; title: string }[];
  sent: number;
}

/** Send what is new or due a repeat. Never throws for one area's failure; the caller wraps the rest. */
export async function checkGeneratorAlerts(
  nowMs: number = Date.now(),
): Promise<GeneratorAlertSummary> {
  const rules = (await listEnabled()).filter(
    (r) => r.trigger?.kind === "exercise",
  );
  const areaIds = [...new Set(rules.map((r) => r.areaId))];
  const summary: GeneratorAlertSummary = {
    areasChecked: 0,
    issues: [],
    sent: 0,
  };

  for (const areaId of areaIds) {
    try {
      const area = await loadAreaForAuth(areaId);
      if (!area || area.legacySystemId == null || area.status !== "active")
        continue;
      const health = await loadGeneratorHealth({
        areaUuid: area.id,
        handle: area.legacySystemId,
        timezone: area.displayTimezone,
        includeOwnerData: true,
        nowMs,
      });
      summary.areasChecked++;
      for (const issue of health.issues) {
        summary.issues.push({
          area: area.displayName,
          code: issue.code,
          title: issue.title,
        });
        if (!ALERTING.has(issue.code)) continue;
        if (!(await claimAlert(area.id, issue))) continue;
        const sent = await sendAlert(
          formatGeneratorAlert(area.displayName, issue),
          "[GeneratorAlerts]",
        );
        if (sent) summary.sent++;
      }
    } catch (err) {
      console.error(`[GeneratorAlerts] area ${areaId} failed:`, err);
    }
  }
  return summary;
}

export function formatGeneratorAlert(
  areaName: string,
  issue: GeneratorIssue,
): string {
  const icon = issue.severity === "critical" ? "🚨" : "⚠️";
  return `${icon} Generator at ${areaName}: ${issue.title}${issue.detail ? `\n${issue.detail}` : ""}`;
}

/**
 * What identifies one episode of an issue, so a NEW one alerts at once.
 *
 * `sinceMs` is a stable onset for most codes — the controller's last reading while it is offline,
 * the slot an exercise was due. NOT for the battery: its `sinceMs` is the latest reading, which moves
 * every push, and keying on it would page every 15 minutes. A battery episode is therefore just
 * "the battery is in this state", repeated on the throttle alone.
 */
function episodeOf(issue: GeneratorIssue): string {
  if (issue.code === "battery_low" || issue.code === "battery_flat")
    return "ongoing";
  return String(issue.sinceMs ?? "none");
}

/**
 * True when this episode is due an alert — first sight, or {@link REPEAT_HOURS} since the last.
 * SET NX with a TTL is the whole mechanism: the key exists exactly while the alert is "recent".
 * A KV failure fails OPEN (alerts), because a missed page is worse than a repeated one.
 */
async function claimAlert(
  areaId: string,
  issue: GeneratorIssue,
): Promise<boolean> {
  const key = kvKey(
    `alert:generator:${areaId}:${issue.code}:${episodeOf(issue)}`,
  );
  try {
    const ok = await kv.set(key, String(Date.now()), {
      nx: true,
      ex: REPEAT_HOURS * 3600,
    });
    return ok != null;
  } catch (err) {
    console.error("[GeneratorAlerts] throttle unavailable, alerting:", err);
    return true;
  }
}
