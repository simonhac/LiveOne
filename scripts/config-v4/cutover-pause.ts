#!/usr/bin/env tsx
/**
 * config-v4 cutover pause — the window's step 1 (and its step-7 inverse), as ONE command.
 *
 * "Pause materialization" is TWO independent actions, and the plan of record used to name only the
 * first:
 *
 *   1. the `<env>:cutover:paused` KV flag — gates the six cron routes that call `cutoverSkipReason`
 *      (relay-outbox, daily, repair-coverage, monitor-observations, run-periods, and the derived agg_5m
 *      writers in minutely) AND, since this change, `/api/observations/receive` itself; and
 *   2. the QStash **queue** pause — stops DELIVERY. A paused queue keeps ACCEPTING enqueues, which is
 *      exactly what the window needs: pollers never stop, they just buffer.
 *
 * Doing only (1) leaves QStash delivering into a receiver that now refuses (500 → retry, no data loss,
 * but a retry storm and DLQ risk). Doing only (2) leaves the crons writing. Neither alone is the pause.
 *
 * ⚠️  `--env` is REQUIRED and NEVER inferred. Both targets are ambient-environment-derived in the app
 *     (`kvKey()` prefixes with `getEnvironment()`, which reads VERCEL_ENV; `OBSERVATIONS_QUEUE_NAME`
 *     keys off NODE_ENV), so a script run from a laptop would silently address `dev:cutover:paused` and
 *     `observations-dev` while prod reads `prod:cutover:paused` and `observations` — a pause that
 *     appears to succeed and does nothing. This script builds both names literally from `--env`.
 *
 * ⚠️  `--env=dev` deliberately touches KV ONLY. The two discriminators disagree: on Vercel, NODE_ENV is
 *     "production" for PREVIEW deployments too, so the deployed `liveone-dev` app resolves
 *     `OBSERVATIONS_QUEUE_NAME` to the SAME `observations` queue prod uses. Pausing "the dev queue"
 *     would therefore either hit a queue nothing publishes to (`observations-dev`, the LOCAL-dev name)
 *     or stop PROD ingest. Neither is wanted, and neither is needed: dev/preview run with
 *     `CRONS_ENABLED` unset, so `liveone-dev` never publishes and QStash never delivers to it.
 *
 * Usage:
 *   npx tsx scripts/config-v4/cutover-pause.ts status --env=prod
 *   npx tsx scripts/config-v4/cutover-pause.ts set    --env=dev
 *   npx tsx scripts/config-v4/cutover-pause.ts clear  --env=dev
 *
 * EVERY `--env=prod` action requires `--i-understand-this-is-prod` — including `clear`, which is the
 * resume the runbook calls the one-way door.
 *
 * After `set`, prove it before starting stage 4 (note the target mode — see guard.ts):
 *   CONFIG_V4_TARGET=prod ALLOW_PROD_DB_IN_DEV=true PLANETSCALE_DATABASE_URL=… \
 *     npx tsx scripts/config-v4/parity-check.ts --quiescence --i-understand-this-is-prod
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { Client } from "@upstash/qstash";
import { kv } from "@/lib/kv";
import { CUTOVER_PAUSED_KEY } from "@/lib/cron/guard";

type Env = "prod" | "dev";
type Action = "status" | "set" | "clear";

const ACTIONS: Action[] = ["status", "set", "clear"];

function usage(msg: string): never {
  console.error(
    `${msg}\n\nUsage: cutover-pause.ts <${ACTIONS.join("|")}> --env=<prod|dev> [--i-understand-this-is-prod]`,
  );
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  const action = argv.find((a) => !a.startsWith("-")) as Action | undefined;
  if (!action || !ACTIONS.includes(action))
    usage(`Missing or unknown action: ${action ?? "(none)"}`);

  const envArg = argv
    .find((a) => a.startsWith("--env="))
    ?.slice("--env=".length);
  if (envArg !== "prod" && envArg !== "dev")
    usage("--env=prod|dev is required (it is never inferred — see the header)");
  const env: Env = envArg;

  // Applies to CLEAR too: resuming is the one-way door, and it is the command most likely to be
  // re-run from shell history against the wrong target.
  if (env === "prod" && !argv.includes("--i-understand-this-is-prod"))
    usage(
      `Refusing: '${action} --env=prod' requires --i-understand-this-is-prod`,
    );

  // mirrors lib/kv.ts kvKey(): `${getEnvironment()}:${pattern}`
  const kvKeyName = `${env}:${CUTOVER_PAUSED_KEY}`;
  // Only prod has a queue half — see the header.
  const queueName = env === "prod" ? "observations" : null;

  // FAIL CLOSED on missing credentials. lib/kv.ts degrades to a Proxy returning `() => Promise.resolve(null)`
  // for EVERY method when KV is unconfigured — it never throws. So without this check, `clear` would
  // no-op the `kv.del`, read back null, conclude "not paused", agree with a genuinely-resumed queue, and
  // print "✅ LIVE" while prod stayed paused forever.
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN)
    usage(
      "KV_REST_API_URL / KV_REST_API_TOKEN unset — lib/kv.ts would silently no-op every operation and this script would report success. Refusing.",
    );

  let queue: ReturnType<Client["queue"]> | null = null;
  if (queueName) {
    const token = process.env.OBSERVATIONS_QSTASH_TOKEN;
    if (!token)
      usage(
        "OBSERVATIONS_QSTASH_TOKEN unset — cannot reach the queue half of the pause",
      );
    queue = new Client({ token }).queue({ queueName });
    // Prove the queue EXISTS before touching it. `upsert` would create-or-update, so a wrong name (typo,
    // wrong Upstash account, a future rename in lib/qstash.ts this mirror didn't follow) would silently
    // mint a phantom queue — and the read-back below would then confirm the phantom, making the whole
    // verification unfalsifiable.
    try {
      await queue.get();
    } catch (e) {
      usage(
        `Queue '${queueName}' not found on this OBSERVATIONS_QSTASH_TOKEN (${e instanceof Error ? e.message : String(e)}).\n` +
          "Refusing rather than creating it: a phantom queue would make the pause verification unfalsifiable.",
      );
    }
  }

  console.log(
    `target: env=${env}  kv=${kvKeyName}  queue=${queueName ?? "(none — dev has no queue half; see header)"}\n`,
  );

  // `pause()`/`resume()` hit the dedicated endpoints, which touch ONLY the paused flag. `upsert({paused})`
  // would also POST `parallelism: request.parallelism ?? 1`, silently resetting an operator-tuned drain
  // rate (the admin UI offers raising it to 8) to 1 — on both set AND clear.
  if (action === "set") {
    // Queue first: stop delivery at the source, so the receiver's gate only has to catch the handful of
    // already-dispatched messages. Arming the flag first would 500 everything still in flight and burn
    // QStash's retry budget toward the DLQ.
    if (queue) await queue.pause();
    await kv.set(kvKeyName, "1");
  } else if (action === "clear") {
    // Mirror image: un-gate the writers BEFORE delivery resumes, so the drained backlog meets a fully
    // live app rather than a receiver still refusing.
    await kv.del(kvKeyName);
    if (queue) await queue.resume();
  }

  // Always report OBSERVED state — never assume the write took.
  const flag = await kv.get(kvKeyName);
  const flagSet = !(
    flag === null ||
    flag === undefined ||
    flag === 0 ||
    flag === "0" ||
    flag === false
  );
  let queuePaused: boolean | "n/a" | "unknown" = queue ? "unknown" : "n/a";
  let queueDetail = "";
  if (queue) {
    try {
      const info = await queue.get();
      queuePaused = info.paused ?? false;
      queueDetail = ` (lag=${info.lag ?? "?"}, parallelism=${info.parallelism ?? "?"})`;
    } catch (e) {
      console.warn(
        `  (queue.get failed: ${e instanceof Error ? e.message : String(e)})`,
      );
    }
  }

  const mark = (on: boolean | "n/a" | "unknown") =>
    on === "unknown" ? "❓" : on === "n/a" ? "➖" : on ? "⏸️ " : "▶️ ";
  console.log(
    `  ${mark(flagSet)} KV flag   ${kvKeyName} = ${flagSet ? "SET (paused)" : "unset (live)"}`,
  );
  console.log(
    `  ${mark(queuePaused)} QStash    ${queueName ?? "—"} = ${
      queuePaused === "unknown"
        ? "UNKNOWN"
        : queuePaused === "n/a"
          ? "n/a (dev publishes nothing: CRONS_ENABLED unset)"
          : queuePaused
            ? "paused"
            : "delivering"
    }${queueDetail}`,
  );

  const halves = queuePaused === "n/a" ? true : flagSet === queuePaused;
  if (queuePaused === "unknown" || !halves) {
    console.error(
      "\n❌ HALF-PAUSED — the two halves disagree (or the queue state is unknown). Neither alone is a\n" +
        "   pause: the KV flag leaves QStash delivering, and the queue pause leaves the crons writing.\n" +
        "   Resolve before touching stage 4.",
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    flagSet
      ? "\n✅ PAUSED. Pollers keep buffering into observations_outbox.\n" +
          "   Next: parity-check.ts --quiescence must go green before stage 4."
      : "\n✅ LIVE. The buffered backlog will drain.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
