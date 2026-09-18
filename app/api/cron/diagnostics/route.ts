/**
 * Diagnostic acquisition worker — reads the inverter's internal event logs when something asked it
 * to, and NEVER otherwise.
 *
 * GET /api/cron/diagnostics  (minutely, see vercel.json)
 *
 * The design constraint that shapes this whole route: it is not polite, and not free, to open an SP
 * LINK session to the inverter every minute. So the worker is demand-driven. With no due job it
 * makes no inverter connection at all — it reads one row and returns. A job exists only because
 * something transitioned: a fault appeared on the Select.live Events page, an active fault cleared,
 * the polled fault code changed, or an operator asked for one from the CLI.
 *
 * One job per tick, and one at a time per device: the inverter permits a single SP LINK session, and
 * an attempt gets a 40-second budget inside the 60-second function. A job that fails goes back to
 * `pending` on the 1/5/15/60-minute ladder rather than being lost, because the symptom that made it
 * interesting — communications down — is exactly the symptom that makes the first attempt fail.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCronOrAdmin } from "@/lib/api-auth";
import { cronSkipReason } from "@/lib/cron/guard";
import { acquireCronLease } from "@/lib/cron/run-lock";
import { planetscaleDb } from "@/lib/db/planetscale";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";
import { getDeviceCredentials } from "@/lib/secure-credentials";
import {
  acquireDiagnostics,
  ATTEMPT_BUDGET_MS,
} from "@/lib/diagnostics/acquire";
import { claimDueJob, finishJob } from "@/lib/diagnostics/store";

export const maxDuration = 60;
/** The job's lease outlives its attempt budget, so a crashed function is reclaimed, not re-raced. */
const LEASE_MS = ATTEMPT_BUDGET_MS + 20_000;

export async function GET(request: NextRequest) {
  const auth = await requireCronOrAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const skip = cronSkipReason(request, auth);
  if (skip) return NextResponse.json(skip);
  if (!planetscaleDb) return NextResponse.json({ configured: false });

  const isCron = !auth.isAdmin && !auth.isClaudeDev;
  const lease = isCron
    ? await acquireCronLease("diagnostics", crypto.randomUUID())
    : { release: async () => {} };
  if (!lease)
    return NextResponse.json({ skipped: true, reason: "overlapping run" });

  const startedAt = Date.now();
  try {
    const job = await claimDueJob(LEASE_MS);
    // The common case, by design: nothing to do, and no inverter was contacted.
    if (!job) return NextResponse.json({ configured: true, claimed: false });

    const device = await DeviceConfigRegistry.deviceByHandle(job.deviceRid);
    if (!device) {
      await finishJob(job.id, {
        status: "abandoned",
        error: `Device ${job.deviceRid} no longer exists.`,
        leaseToken: job.leaseToken,
        reasonsAtClaim: job.reasonsAtClaim,
      });
      return NextResponse.json({
        configured: true,
        jobId: job.id,
        abandoned: true,
      });
    }
    if (device.vendorType !== "selectronic") {
      await finishJob(job.id, {
        status: "abandoned",
        error: `Diagnostic acquisition is only implemented for Selectronic; device ${job.deviceRid} is ${device.vendorType}.`,
        leaseToken: job.leaseToken,
        reasonsAtClaim: job.reasonsAtClaim,
      });
      return NextResponse.json({
        configured: true,
        jobId: job.id,
        abandoned: true,
      });
    }
    const serial = device.serial ?? device.vendorSiteId;
    const credentials = await getDeviceCredentials(
      device.ownerClerkUserId ?? "",
      device.id,
    );
    if (!credentials?.email || !credentials?.password) {
      // Not retryable on a timer: no amount of waiting produces a credential.
      await finishJob(job.id, {
        status: "abandoned",
        error: "No stored Select.live credentials for this device.",
        leaseToken: job.leaseToken,
        reasonsAtClaim: job.reasonsAtClaim,
      });
      return NextResponse.json({
        configured: true,
        jobId: job.id,
        abandoned: true,
      });
    }

    const signal = AbortSignal.timeout(ATTEMPT_BUDGET_MS + 5_000);
    try {
      const outcome = await acquireDiagnostics({
        deviceRid: device.id,
        serial,
        portal: { email: credentials.email, password: credentials.password },
        inverterPassword: credentials.inverterPassword,
        timezone: device.displayTimezone,
        jobId: job.id,
        reasons: job.reasons,
        budgetMs: ATTEMPT_BUDGET_MS,
        signal,
      });
      // A partial capture is still stored and still linked to the job; the job only finishes when
      // the capture is COMPLETE, so an outage that truncated the walk is retried rather than
      // declared done on the strength of whatever it managed to read.
      const result = outcome.complete
        ? await finishJob(job.id, {
            status: "done",
            leaseToken: job.leaseToken,
            reasonsAtClaim: job.reasonsAtClaim,
          })
        : await finishJob(job.id, {
            status: "failed",
            error: outcome.error ?? "Capture incomplete.",
            attempts: job.attempts,
            leaseToken: job.leaseToken,
            reasonsAtClaim: job.reasonsAtClaim,
          });
      console.log(
        `[Diagnostics] device=${device.id} capture=${outcome.captureId} records=${outcome.recordCount} new=${outcome.newRecordCount} complete=${outcome.complete}` +
          (outcome.lostOverlap.length
            ? ` LOST-OVERLAP=${outcome.lostOverlap.join(",")}`
            : "") +
          (outcome.unverifiedOverlap.length
            ? ` overlap-unverified=${outcome.unverifiedOverlap.join(",")}`
            : "") +
          (outcome.skippedLogs.length
            ? ` NOT-READ=${outcome.skippedLogs.join(",")}`
            : "") +
          // The job grew a reason while we were reading it, so the acquisition did not cover
          // everything it is now being asked about; a follow-up is already pending.
          (result.followUp ? " FOLLOW-UP-SCHEDULED" : "") +
          // Our lease was reclaimed while we worked. The capture is stored; the job is somebody
          // else's now, and we wrote nothing to it.
          (result.written ? "" : " (lease lost; job not updated)"),
      );
      return NextResponse.json({
        configured: true,
        claimed: true,
        jobId: job.id,
        deviceRid: device.id,
        durationMs: Date.now() - startedAt,
        jobUpdated: result.written,
        followUp: result.followUp,
        ...outcome,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Acquisition failed.";
      await finishJob(job.id, {
        status: "failed",
        error: message,
        attempts: job.attempts,
        leaseToken: job.leaseToken,
        reasonsAtClaim: job.reasonsAtClaim,
      });
      console.error(`[Diagnostics] device=${device.id} failed: ${message}`);
      return NextResponse.json({
        configured: true,
        claimed: true,
        jobId: job.id,
        error: message,
        durationMs: Date.now() - startedAt,
      });
    }
  } finally {
    await lease.release();
  }
}
