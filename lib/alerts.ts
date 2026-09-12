/**
 * The one outbound alert sender.
 *
 * Extracted from `/api/cron/monitor-observations`, which had it inline, so that anything else with
 * something worth waking someone for can send one without re-deriving the policy — in particular the
 * `[${envLabel()}]` prefix, which `lib/env.ts` requires of EVERY sender because the webhook is
 * shared between dev and prod.
 *
 * Best-effort by design: unset webhook is a silent no-op (dev and preview must never page), and a
 * network failure is logged, never thrown. An alert that can take down the thing it is reporting on
 * is worse than no alert.
 */
import { envLabel } from "@/lib/env";

/**
 * Post `text` to the shared Slack-compatible webhook. Returns false when unsent — unconfigured or
 * failed, deliberately not distinguished by the return value; callers report `alertWebhookConfigured`
 * separately when they care.
 *
 * `tag` prefixes the local console line only (never the message itself) so a failure is traceable to
 * the caller that raised it.
 */
export async function sendAlert(text: string, tag: string): Promise<boolean> {
  const url = process.env.OBSERVATIONS_ALERT_WEBHOOK_URL;
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `[${envLabel()}] ${text}` }),
    });
    return res.ok;
  } catch (err) {
    console.error(`${tag} alert webhook failed:`, err);
    return false;
  }
}
