/**
 * `GET /api/v4/automations/evaluator` — is the automation evaluator actually sweeping?
 *
 * 🛑 A LITERAL segment sitting beside `[id]`. Next resolves static segments before dynamic ones, so
 * this wins over `/api/v4/automations/{au_…}` — and `Automation.parse("evaluator")` would fail
 * anyway, so the collision is doubly harmless. It is a trap worth knowing about rather than
 * rediscovering, which is why `automations.test.ts` pins the precedence.
 *
 * `requireAdmin`, not owner-scoped: a sweep spans every owner's rules, and "3 errors last tick" is
 * a fact about somebody else's fleet as much as your own. A non-admin CLI token gets past the edge
 * and 403s here, which is the documented posture for the admin reads in `cliTokenRoutes`.
 *
 * Answers from the KV record the minutely pass leaves behind. An ABSENT record is the interesting
 * answer, not an error: the key has a one-hour TTL, so "nothing here" means the evaluator has not
 * completed a pass within the hour.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import {
  readLastSweep,
  readUndecidedSuppressedUntil,
} from "@/lib/automations/evaluate";
import * as store from "@/lib/automations/store";
import { parseAutomationTrigger } from "@/lib/automations/types";

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const [sweep, suppressedUntil, enabled] = await Promise.all([
    readLastSweep(),
    readUndecidedSuppressedUntil(),
    store.listEnabled(),
  ]);

  let exercise = 0;
  let chargeSession = 0;
  for (const row of enabled) {
    const t = parseAutomationTrigger(row.trigger);
    if (!t.ok) continue;
    if (t.value.kind === "exercise") exercise++;
    else chargeSession++;
  }

  const nowMs = Date.now();
  return NextResponse.json({
    // 🛑 The kill switch, and the reason it is reported first. `CRONS_ENABLED !== "true"` means the
    // evaluator is not merely quiet, it is switched OFF — a different remedy entirely from a broken
    // cron, and indistinguishable from it without this line.
    cronsEnabled: process.env.CRONS_ENABLED === "true",
    schedule: "* * * * *",
    lastSweep: sweep
      ? {
          at: new Date(sweep.at).toISOString(),
          ageSeconds: Math.round((nowMs - sweep.at) / 1000),
          durationMs: sweep.durationMs,
          summary: sweep.summary,
        }
      : null,
    undecidedAlertSuppressedUntil: suppressedUntil
      ? new Date(suppressedUntil).toISOString()
      : null,
    counts: { enabled: enabled.length, exercise, chargeSession },
  });
}
