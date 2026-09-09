import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { qstash } from "@/lib/qstash";
import {
  readIngestState,
  pinLaneParallelism,
  unpinLaneParallelism,
  setLanePaused,
  updateLegacyQueue,
  type IngestState,
} from "@/lib/observations/flow-control";
import {
  OBSERVATION_LANES,
  type ObservationLane,
} from "@/lib/observations/types";

/**
 * The observations ingest path — status and control, for `liveone queue`.
 *
 * "queue" now names the INGEST PATH, not a QStash Queue: the path is two flow-control lanes
 * (`live`, `backfill`) plus, for the length of the coexistence window, the legacy FIFO Queue. The
 * name and the address are kept deliberately — they are in the generated CLI reference and they are
 * the muscle memory built during the 2026-09-09 incident.
 *
 * It exists as a SEPARATE address rather than by admitting `/api/admin/observations/info` to the
 * CLI-token allowlist: `/api/admin/*` is deliberately outside that allowlist ("a stray `lo_cli_`
 * bearer can never skip the edge on admin, control or vendor routes"), and `auth.protect()` rewrites
 * it to a 404 before any handler sees the bearer. Verified 2026-09-09: a valid CLI token against
 * `/api/admin/amber-sync` returns `404` with `x-clerk-auth-reason: protect-rewrite, token-invalid`.
 *
 *   GET   → the aggregate below
 *   PATCH { lane, paused?, parallelism? } → the same shape, after applying
 *
 * 🛑 **`stalledMinutes` is the field that matters, not `lag`.** During the stall a rising `lag` was
 * read twice as a throughput deficit; it is ambiguous, because a busy path and a blocked one both
 * grow. `lastIngestedAt` aged against now is not: a busy path still ingests. `stuck` per lane —
 * saturated AND backed up AND nothing landing — is the unambiguous form of the same question.
 *
 * Admin only (`requireAdmin`), which a CLI token resolves through exactly like a browser session.
 * See `docs/plans/ingest-head-of-line-hardening.md`.
 */

/** Concurrency ceiling. See the 🛑 on `validateParallelism` — the invariant is on the SUM. */
function poolMax(): number {
  return Number(process.env.PLANETSCALE_POOL_MAX ?? 10);
}

const err = (message: string, status = 422) =>
  NextResponse.json({ error: message }, { status });

type LaneScope = ObservationLane | "all";

function parseLane(value: unknown): LaneScope | null {
  if (value === "all") return "all";
  return OBSERVATION_LANES.find((l) => l === value) ?? null;
}

/** The lanes a scope names. */
function lanesOf(scope: LaneScope): ObservationLane[] {
  return scope === "all" ? [...OBSERVATION_LANES] : [scope];
}

/**
 * 🛑 The ceiling is the Postgres pool, and the invariant is on the SUM ACROSS LANES, not on either
 * lane alone. Every in-flight delivery is a concurrent receiver invocation and therefore a Postgres
 * connection, so `live + backfill` must stay within `PLANETSCALE_POOL_MAX` — starving the web app to
 * drain a backlog trades one outage for another. The error names the sum, because that is the number
 * nobody will otherwise think about.
 */
function validateParallelism(
  state: IngestState,
  scope: LaneScope,
  n: number,
): string | null {
  const max = poolMax();
  if (!Number.isInteger(n) || n < 1)
    return `parallelism must be a positive integer (or null to unpin)`;

  const targets = new Set<ObservationLane>(lanesOf(scope));
  const sum = state.lanes.reduce(
    (acc, l) => acc + (targets.has(l.lane) ? n : l.parallelism),
    0,
  );
  if (sum > max)
    return (
      `parallelism ${n} on ${scope} would put the SUM across lanes at ${sum}, over the ` +
      `Postgres pool of ${max} (PLANETSCALE_POOL_MAX). Every in-flight delivery holds a ` +
      `connection — lower another lane first.`
    );
  return null;
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;
  if (!qstash)
    return NextResponse.json(
      { error: "QStash not configured" },
      { status: 503 },
    );

  return NextResponse.json(await readIngestState());
}

export async function PATCH(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;
  if (!qstash)
    return NextResponse.json(
      { error: "QStash not configured" },
      { status: 503 },
    );

  const body = (await request.json().catch(() => null)) as {
    lane?: unknown;
    paused?: unknown;
    parallelism?: unknown;
  } | null;
  if (!body || (body.paused === undefined && body.parallelism === undefined))
    return err("Body must set at least one of: paused, parallelism");

  const wantsParallelism = body.parallelism !== undefined;
  const before = await readIngestState();

  // Scope resolution, and the one place a write can be refused for being too broad.
  //
  // `lane` is REQUIRED for a parallelism write under flow control — a per-lane cap applied
  // fleet-wide is exactly the accident worth refusing, and the sum-vs-pool check below only means
  // something when the operator has said which lane they meant. Everything else defaults to `all`:
  //   • pause/resume has always meant the whole path, and
  //   • the legacy queue IS one undifferentiated lane, so under `mode: "queue"` there is nothing to
  //     scope to. Requiring a lane there would 422 the `liveone queue` build that is deployed today,
  //     mid-incident, for no safety gained.
  const laneRequired = wantsParallelism && before.mode === "flow";
  const scope: LaneScope | null =
    body.lane === undefined
      ? laneRequired
        ? null
        : "all"
      : parseLane(body.lane);
  if (!scope)
    return err(
      `lane must be one of: ${OBSERVATION_LANES.join(", ")}, all` +
        (body.lane === undefined
          ? " — required when setting parallelism, so a per-lane cap is never applied fleet-wide"
          : ""),
    );

  // A lane-scoped write against the legacy queue would report success and change nothing about what
  // is actually being delivered, which is worse than refusing it.
  if (before.mode === "queue" && scope !== "all")
    return err(
      `OBSERVATIONS_PUBLISH_MODE is "queue", and the legacy queue has no lanes — ` +
        `use lane "all" until the flow-control cutover.`,
    );

  let parallelism: number | null | undefined;
  if (wantsParallelism) {
    if (body.parallelism === null) {
      parallelism = null; // unpin
    } else {
      const n = Number(body.parallelism);
      const invalid =
        before.mode === "queue"
          ? !Number.isInteger(n) || n < 1 || n > poolMax()
            ? `parallelism must be an integer between 1 and ${poolMax()} (the Postgres pool size)`
            : null
          : validateParallelism(before, scope, n);
      if (invalid) return err(invalid);
      parallelism = n;
    }
  }

  let paused: boolean | undefined;
  if (body.paused !== undefined) {
    if (typeof body.paused !== "boolean")
      return err("paused must be a boolean");
    paused = body.paused;
  }

  if (before.mode === "queue") {
    if (parallelism === null)
      return err(
        `the legacy queue cannot be unpinned — parallelism: null applies to flow-control lanes only`,
      );
    await updateLegacyQueue({
      ...(paused !== undefined ? { paused } : {}),
      ...(parallelism !== undefined ? { parallelism } : {}),
    });
  } else {
    for (const lane of lanesOf(scope)) {
      if (paused !== undefined) await setLanePaused(lane, paused);
      if (parallelism === null) await unpinLaneParallelism(lane);
      else if (parallelism !== undefined)
        await pinLaneParallelism(lane, parallelism);
    }
  }

  return NextResponse.json(await readIngestState());
}
