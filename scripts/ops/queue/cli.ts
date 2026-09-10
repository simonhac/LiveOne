/**
 * The `queue` domain of the `liveone` CLI — the observations ingest path: is it flowing, and if
 * not, make it flow.
 *
 * A COMPOSABLE module (spec + dispatcher, no entrypoint), mounted by `scripts/ops/liveone.ts`.
 * ADMIN-ONLY over http: `/api/v4/queue` is `requireAdmin`, so a non-admin token gets the mapped 403.
 *
 * Why this domain exists: on 2026-09-09 a backfill wedged the queue and stopped ALL observation
 * ingest for ~50 minutes, and the only way to see it — let alone act on it — was to hand-drive a
 * logged-in browser against `/api/admin/observations/*`, which no CLI token can reach. Being able to
 * watch a stall and not touch it is the gap this closes. See
 * `docs/plans/ingest-head-of-line-hardening.md`.
 *
 * 🛑 **"queue" names the ingest PATH, not a QStash Queue.** The path is two flow-control lanes
 * (`live`, `backfill`) plus, for the length of the coexistence window, the legacy FIFO Queue. The
 * domain name is kept deliberately: it is in the generated reference, and it is the muscle memory
 * built during the incident.
 */
import {
  bool,
  defineCommand,
  EXIT,
  str,
  type CommandSpec,
  type Ctx,
  type FlagSpec,
} from "@/lib/cli/cli";
import { withApiSession } from "@/lib/cli-kit/api-session";
import { apiFetch } from "@/lib/cli-kit/http";
import { BASE_URL_FLAG, usage } from "../shared";

/** Mirrors `ObservationLane` in `lib/observations/types.ts`. Duplicated: see `LANE_FLAG`. */
export const LANES = ["live", "backfill"] as const;
export type Lane = (typeof LANES)[number];
export type LaneScope = Lane | "all";

/** One lane of `IngestState`, as `/api/v4/queue` reports it. */
export interface WireLane {
  lane: Lane;
  key: string;
  waiting: number;
  inFlight: number;
  parallelism: number;
  pinned: boolean;
  paused: boolean;
  idle: boolean;
  stuck: boolean;
  /** Set when the lane could NOT be read. Never the same as an idle lane — see `laneState`. */
  error?: string;
}

/**
 * `/api/v4/queue`'s v2 body (`IngestState`).
 *
 * The compat fields (`paused`/`lag`/`parallelism`) are the ones the PREVIOUS build of this CLI read,
 * and they are typed optional here for the mirror-image reason: this build may be pointed at an
 * origin that predates the lane split (a rollback, or a preview). Nothing below indexes `lanes`
 * without a fallback, so an old origin degrades to the one-line read rather than a TypeError.
 */
export interface WireQueue {
  name: string;
  mode: "queue" | "flow";
  globalParallelism: { max: number; inFlight: number } | null;
  waiting: number;
  inFlight: number | null;
  pausedLanes: Lane[];
  lanes?: WireLane[];
  legacyQueue?: {
    name: string;
    paused: boolean;
    lag: number;
    parallelism: number;
    exists: boolean;
    error?: string;
  } | null;
  lastIngestedAt: string | null;
  stalledMinutes: number | null;
  stalled?: boolean;
  paused: boolean;
  lag: number;
  parallelism: number;
}

/**
 * How many minutes without a durable write before `status` calls it a finding.
 *
 * Steady state is ~43 observations/minute across every device, so a gap this long is not a quiet
 * period — it is a stall. Deliberately generous relative to the one-minute poll: a single slow
 * message must not page.
 *
 * Duplicated from `INGEST_STALL_THRESHOLD_MIN` in `lib/observations/flow-control.ts` on purpose —
 * this CLI judges a *deployed* origin's answer and cannot import that module's value from it.
 */
const STALL_THRESHOLD_MIN = 5;

/**
 * 🛑 The lane enum is spelled out rather than imported from `lib/observations/types.ts`.
 *
 * Same reason as the threshold above, but it bites harder: the flag is a *client* contract against
 * whatever origin is deployed, and silently inheriting a lane this checkout invented but prod has
 * never heard of would turn a rename into an accepted flag that 422s at the far end.
 */
const LANE_FLAG = {
  lane: {
    type: "string",
    placeholder: "lane",
    values: [...LANES, "all"],
    help: "Which lane: live, backfill, or all. Required to SET parallelism (a per-lane cap is never applied fleet-wide).",
  },
} as const satisfies Record<string, FlagSpec>;

/**
 * The same flag on a READ verb, where it only narrows the view.
 *
 * Separate wording rather than one shared string: "required to set parallelism" is a write-gate
 * rule, and printing it under a read verb describes a constraint that does not exist there.
 */
const LANE_FILTER_FLAG = {
  lane: {
    type: "string",
    placeholder: "lane",
    values: [...LANES, "all"],
    help: "Only this lane: live, backfill, or all (default: all).",
  },
} as const satisfies Record<string, FlagSpec>;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** The one-word state of a lane, most-alarming-first. */
function laneState(l: WireLane): string {
  // 🛑 `error` outranks everything, including `idle`. "I could not read this lane" and "this lane is
  // quiet" are the distinction the whole flow-control module exists to preserve, and collapsing them
  // here would put it back — as the reassuring one.
  if (l.error) return `UNREADABLE (${l.error})`;
  if (l.stuck) return "STUCK";
  if (l.paused) return "PAUSED";
  if (l.idle) return "idle";
  return "ok";
}

const pad = (s: string, w: number) => s.padEnd(w);

function renderLanes(lanes: WireLane[]): string {
  const w = Math.max(4, ...lanes.map((l) => l.lane.length));
  const head = `${pad("lane", w)}  waiting  in flight  parallelism  state`;
  const rows = lanes.map(
    (l) =>
      `${pad(l.lane, w)}  ${String(l.waiting).padStart(7)}  ${String(
        l.inFlight,
      ).padStart(9)}  ${String(l.parallelism).padStart(11)}${
        l.pinned ? "*" : " "
      } ${laneState(l)}`,
  );
  return [head, ...rows].join("\n");
}

export function render(q: WireQueue): string {
  const stalled =
    q.stalledMinutes == null
      ? "never ingested"
      : `${q.stalledMinutes} min since last ingest`;
  const lines = [
    `ingest       ${q.name}  (mode: ${q.mode})`,
    `last ingest  ${q.lastIngestedAt ?? "(none)"}  — ${stalled}`,
  ];

  const lanes = q.lanes ?? [];
  if (lanes.length) {
    lines.push("", renderLanes(lanes));
    if (lanes.some((l) => l.pinned))
      lines.push(
        "* pinned — an operator set this cap; our publishes cannot revert it.",
      );
  } else {
    // An origin that predates the lane split. Say so, rather than printing an empty table.
    lines.push(
      "",
      `lag          ${q.lag}`,
      `parallelism  ${q.parallelism}${q.paused ? "  PAUSED" : ""}`,
      "(this origin reports no lanes — it predates the flow-control split)",
    );
  }

  if (q.globalParallelism)
    lines.push(
      "",
      `account-wide in flight ${q.globalParallelism.inFlight}/${q.globalParallelism.max}` +
        " — a cap here holds down every lane at once",
    );

  const lq = q.legacyQueue;
  if (lq)
    lines.push(
      lq.exists
        ? `legacy queue "${lq.name}"  lag ${lq.lag}  parallelism ${lq.parallelism}${
            lq.paused ? "  PAUSED" : ""
          }`
        : `legacy queue "${lq.name}"  (not created)`,
    );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

export const queueCommand = defineCommand({
  name: "queue",
  summary:
    "The observations ingest path — per-lane status, and the levers to unblock it.",
  when:
    "Reach for this when readings have stopped arriving, or before and after a large backfill.\n" +
    "`status` is the one-screen health read; `parallelism` is the lever that clears a stall.",
  description:
    "Admin-only, http-only. Prints `target: <origin> as <you>` on stderr first.\n\n" +
    "READ `stalled` and `STUCK`, NOT `lag`. A rising lag is ambiguous — a busy path and a blocked\n" +
    "one both grow — and it was misread twice during the 2026-09-09 stall. Minutes since the last\n" +
    "durable write is not ambiguous: a busy path still ingests. `STUCK` on a lane (saturated AND\n" +
    "backed up AND nothing landing) is the same question in its unambiguous form.\n\n" +
    "Ingest runs as two lanes — `live` and `backfill` — so a multi-week backfill can no longer\n" +
    "head-of-line block the minutely polls. Until the cutover the legacy FIFO queue is still the\n" +
    "transport; `status` shows `mode:` so you know which one your write will land on.",
  uses: ["api"],
  subcommands: {
    status: {
      name: "status",
      summary:
        "Is ingest flowing? Per-lane waiting / in-flight / parallelism, and minutes since the last durable write.",
      when:
        "Start here. Exits 1 (findings) when ingest has stalled or any lane is STUCK, so it\n" +
        "composes into a check. `--lane` narrows the table; the verdict still spans the path.",
      flags: { ...LANE_FILTER_FLAG, ...BASE_URL_FLAG },
      examples: [
        "liveone queue status",
        "liveone queue status --lane=backfill",
      ],
    },
    timing: {
      name: "timing",
      summary:
        "How long each batch actually took — per-message wait, duration, attempts and outcome.",
      when:
        "Reach for this after `status` says something is wrong, to find out WHICH kind of wrong.\n" +
        "Read `wait` and `duration` as a pair: a long wait with a short duration means something\n" +
        "AHEAD of that batch held the delivery slot (head-of-line); a long duration is the batch's\n" +
        "own work. `lag` cannot tell those apart, and conflating them misdiagnosed 2026-09-09 twice.\n" +
        "Also the way to watch a large backfill: durations should stay flat as it runs.",
      description:
        "A windowed forensic read, paged out of QStash's delivery log, so keep the window tight —\n" +
        "`--last` defaults to 1h.\n\n" +
        "🛑 The retention is QStash's, not ours: old windows simply return nothing, which is NOT\n" +
        "the same as a quiet window. `truncated` marks a window that outran the page budget, and\n" +
        "every count under it is an undercount.\n\n" +
        "A batch that fails FAST still occupies its slot for the whole retry schedule, so watch\n" +
        "`retries` and `occupancy` alongside `duration` — a wedged FIFO queue looks the same either\n" +
        "way from the outside.",
      flags: {
        last: {
          type: "string",
          placeholder: "2h",
          help: "Window ending now: 90s / 15m / 2h / 7d (default: 1h). Mutually exclusive with --from.",
        },
        from: {
          type: "string",
          placeholder: "when",
          help: "Window start — an ISO instant or epoch-ms. Use with --to for a fixed window.",
        },
        to: {
          type: "string",
          placeholder: "when",
          help: "Window end (default: now). Only with --from.",
        },
        failed: {
          type: "boolean",
          help: "Only batches that did not deliver — the ones worth reading first.",
        },
        limit: {
          type: "string",
          placeholder: "n",
          help: "Show at most this many batches (default: 20). The summary always spans them all.",
        },
        ...LANE_FILTER_FLAG,
        ...BASE_URL_FLAG,
      },
      examples: [
        "liveone queue timing",
        "liveone queue timing --last=6h --failed",
        "liveone queue timing --lane=backfill --last=30m",
        "liveone queue timing --from=2026-09-09T10:30:00Z --to=2026-09-09T13:00:00Z",
      ],
    },
    outbox: {
      name: "outbox",
      summary:
        "Why is publishing failing? The durable buffer's backlog, and the error the relay recorded.",
      when:
        "Reach for this when `status` says ingest has stalled but BOTH transports read empty —\n" +
        "nothing waiting, nothing in flight. That is what a broken PUBLISH looks like: the message\n" +
        "never reached QStash at all, so no QStash view can explain it. The reason is in Postgres.",
      description:
        "🛑 Read `failing`, not `backlog`. An unpublished row means the relay has not got to it\n" +
        "yet, which is the normal steady state between minutes. `attempts > 0` with a `lastError`\n" +
        "is the difference between an ingest path that is behind and one that is broken.\n\n" +
        "Exits 1 (findings) when anything is failing, so it composes into a check.\n\n" +
        "Nothing here is lost: the outbox is teed BEFORE publishing and retains payloads for 30\n" +
        "days, so a failing publish is a latency problem that the relay clears once it can send.",
      flags: {
        limit: {
          type: "string",
          placeholder: "n",
          help: "How many failing rows to show, 1..200 (default: 20). One reason repeated is one finding.",
        },
        ...BASE_URL_FLAG,
      },
      examples: ["liveone queue outbox", "liveone queue outbox --limit=50"],
    },
    pause: {
      name: "pause",
      summary: "Stop a lane dispatching. Messages accumulate; nothing is lost.",
      when:
        "Use this to stop delivery while you diagnose, or before a change that would make the\n" +
        "receiver fail. Publishing is unaffected — the outbox keeps accepting.\n" +
        "Pausing `backfill` alone is how you protect live ingest from a bulk import.",
      mutates: true,
      flags: { ...LANE_FLAG, ...BASE_URL_FLAG },
      examples: [
        "liveone queue pause --apply",
        "liveone queue pause --lane=backfill --apply",
      ],
    },
    resume: {
      name: "resume",
      summary: "Resume dispatching after a pause.",
      when: "The inverse of `pause`. Defaults to every lane.",
      mutates: true,
      flags: { ...LANE_FLAG, ...BASE_URL_FLAG },
      examples: [
        "liveone queue resume --apply",
        "liveone queue resume --lane=backfill --apply",
      ],
    },
    parallelism: {
      name: "parallelism",
      summary:
        "Read, or PIN, how many messages a lane delivers concurrently. The SUM across lanes is capped by the PG pool.",
      when:
        "Raise this when one slow message is head-of-line blocking a lane. With no argument it\n" +
        "reads every lane and writes nothing. Setting a value requires `--lane`.",
      description:
        "Setting PINS the cap. Our own publishes carry a parallelism, so an unpinned change is\n" +
        "reverted by the next published message within ~60s — pinning is what makes it stick.\n" +
        "`--lane=<lane> 0` unpins, handing the lane back to the publish-time default.\n\n" +
        "The ceiling is on the SUM across lanes, not on either lane alone: every in-flight\n" +
        "delivery holds a Postgres connection, so starving the web app to drain a backlog trades\n" +
        "one outage for another. The server owns that check and names the sum when it refuses.",
      mutates: true,
      args: [
        {
          name: "n",
          required: false,
          help: "New concurrency for --lane, or 0 to unpin. Omit to read every lane.",
        },
      ],
      flags: { ...LANE_FLAG, ...BASE_URL_FLAG },
      examples: [
        "liveone queue parallelism",
        "liveone queue parallelism 5 --lane=live --apply",
        "liveone queue parallelism 0 --lane=backfill --apply",
      ],
    },
  },
} satisfies CommandSpec);

// ---------------------------------------------------------------------------
// The write body, resolved against the transport actually in use
// ---------------------------------------------------------------------------

export interface WriteBody {
  lane?: LaneScope;
  paused?: boolean;
  parallelism?: number | null;
}

export type Resolved =
  | { ok: true; body: WriteBody }
  | { ok: false; what: string; why: string; next: string };

/**
 * Turn "what the operator asked for" into "what this origin will accept", given its `mode`.
 *
 * 🛑 This exists because the two transports disagree about lanes, and the disagreement is
 * load-bearing during the coexistence window:
 *
 *   • Under `flow`, `lane` is REQUIRED to set parallelism. A per-lane cap applied fleet-wide is
 *     exactly the accident worth refusing, and the server's sum-vs-pool check only means something
 *     once the operator has said which lane they meant.
 *   • Under `queue`, there are no lanes to scope to, and the server refuses a lane-scoped write
 *     outright rather than reporting a success that changes nothing.
 *
 * The server enforces both. This is not a second enforcement point — it is the difference between a
 * refusal that names the lever and a bare 422, at the moment an operator is mid-incident. The
 * server's answer still wins: anything this lets through is re-checked there.
 */
export function resolveWrite(
  state: Pick<WireQueue, "mode">,
  want: { lane?: string; paused?: boolean; parallelism?: number | null },
): Resolved {
  const setsParallelism = want.parallelism !== undefined;

  if (state.mode === "queue") {
    if (want.lane !== undefined && want.lane !== "all")
      return {
        ok: false,
        what: `this origin has no lane "${want.lane}" yet`,
        why:
          "it still publishes through the legacy FIFO queue (mode: queue), which is one " +
          "undifferentiated lane — a lane-scoped write would change nothing",
        next: "drop --lane until the flow-control cutover; `liveone queue status` shows the mode",
      };
    if (want.parallelism === null)
      return {
        ok: false,
        what: "the legacy queue cannot be unpinned",
        why: "pinning is a flow-control concept; the queue's parallelism is simply a setting",
        next: "pass a concrete concurrency instead, e.g. `liveone queue parallelism 5 --apply`",
      };
    // No `lane` on the wire at all: the route defaults an absent lane to `all`, and sending "all"
    // explicitly would be a second thing to keep in step for no gain.
    const body: WriteBody = {};
    if (want.paused !== undefined) body.paused = want.paused;
    if (setsParallelism) body.parallelism = want.parallelism;
    return { ok: true, body };
  }

  if (setsParallelism && (want.lane === undefined || want.lane === "all"))
    return {
      ok: false,
      what:
        want.lane === "all"
          ? "--lane=all cannot set parallelism"
          : "--lane is required to set parallelism",
      why:
        "the cap is per-lane, and the pool ceiling is on the SUM across lanes — applying one " +
        "number to every lane at once is the accident this refuses",
      next: `name one: ${LANES.map((l) => `--lane=${l}`).join(" or ")}`,
    };

  const body: WriteBody = { lane: (want.lane as LaneScope) ?? "all" };
  if (want.paused !== undefined) body.paused = want.paused;
  if (setsParallelism) body.parallelism = want.parallelism;
  return { ok: true, body };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * The queue route reports a refusal as `{ error }`, not as the validator's `{ errors[] }`.
 *
 * Without this override a 422 renders as "the document was rejected by the server's validator" with
 * an EMPTY list — the server's actual sentence ("parallelism ... would put the SUM across lanes at
 * 14, over the Postgres pool of 10") is thrown away. That is the wrong trade on any route; on the
 * one an operator reaches for mid-stall it is the whole message. After the cutover 422 also becomes
 * the ROUTINE answer to a missing lane, so this stops being an edge case.
 */
const QUEUE_ERRORS = {
  422: {
    exit: EXIT.USAGE,
    what: "the server refused this change",
    why: (body: Record<string, unknown>) =>
      typeof body.error === "string"
        ? body.error
        : "no reason given (the route returned 422 with no `error`)",
    next: "run `liveone queue status` to see the lanes, their caps, and the mode",
  },
} as const;

/** The lane filter, for the read verbs. Undefined and "all" both mean "every lane". */
function laneFilter(ctx: Ctx): LaneScope | undefined {
  const l = str(ctx, "lane");
  return l === undefined || l === "all" ? undefined : (l as Lane);
}

/** `q`, narrowed to the lane the operator asked about. The verdict is never narrowed — see below. */
function narrow(q: WireQueue, lane: LaneScope | undefined): WireQueue {
  if (!lane || !q.lanes) return q;
  return { ...q, lanes: q.lanes.filter((l) => l.lane === lane) };
}

async function runStatus(ctx: Ctx): Promise<number> {
  const only = laneFilter(ctx);
  return withApiSession(ctx, async (s) => {
    const q = await s.get<WireQueue>("/api/v4/queue");
    const stalled =
      q.stalledMinutes != null && q.stalledMinutes > STALL_THRESHOLD_MIN;
    // 🛑 The verdict spans the whole path even under `--lane`. A filter is a way to read less, not a
    // way to be told less: `status --lane=live` reporting OK while `backfill` is wedged would make
    // the flag a footgun in exactly the situation it was added for.
    const stuck = (q.lanes ?? []).filter((l) => l.stuck);
    const view = narrow(q, only);

    ctx.emit(view, () => {
      const out = [render(view)];
      if (stuck.length)
        out.push(
          "",
          `STUCK — ${stuck
            .map((l) => l.lane)
            .join(", ")}: saturated, backed up, and nothing landing.`,
          "Raise that lane's parallelism, or pause the other one to give it the pool.",
        );
      if (stalled)
        out.push(
          "",
          `STALLED — no durable write for ${q.stalledMinutes} min (threshold ${STALL_THRESHOLD_MIN}).`,
        );
      return out.join("\n");
    });
    // A finding, not an error: the command did its job. `liveone queue status || alert` composes.
    return stalled || stuck.length ? EXIT.FINDINGS : EXIT.OK;
  });
}

/** PATCH the ingest path, or — when dry — report what would change without touching it. */
async function patch(
  ctx: Ctx,
  want: { paused?: boolean; parallelism?: number | null },
  describe: (before: WireQueue, body: WriteBody) => string,
): Promise<number> {
  const lane = str(ctx, "lane");
  return withApiSession(ctx, async (s) => {
    const before = await s.get<WireQueue>("/api/v4/queue");
    // Resolved AFTER the read, because the answer depends on the origin's `mode` — which is a
    // property of the deployment, not of this checkout, and flips at the cutover.
    const resolved = resolveWrite(before, { lane, ...want });
    if (!resolved.ok) throw usage(resolved.what, resolved.why, resolved.next);
    const body = resolved.body;

    if (ctx.dryRun) {
      ctx.emit(
        { ...before, applied: false, would: body },
        () =>
          `${render(before)}\n\nwould ${describe(before, body)}\n(dry run — pass --apply to write)`,
      );
      return EXIT.OK;
    }
    const { body: after } = await apiFetch<WireQueue>(
      s.origin,
      "/api/v4/queue",
      { method: "PATCH", body, token: s.token, errors: QUEUE_ERRORS },
    );
    ctx.emit({ ...after, applied: true }, () => render(after));
    return EXIT.OK;
  });
}

/** How a write names its target, for the dry-run sentence. */
const scopeOf = (b: WriteBody) =>
  b.lane === undefined || b.lane === "all" ? "every lane" : `lane ${b.lane}`;

const runPause = (ctx: Ctx) =>
  patch(ctx, { paused: true }, (_b, body) => `pause ${scopeOf(body)}`);

const runResume = (ctx: Ctx) =>
  patch(ctx, { paused: false }, (_b, body) => `resume ${scopeOf(body)}`);

async function runParallelism(ctx: Ctx): Promise<number> {
  const raw = ctx.args[0];
  // No argument is a READ, and must not be a no-op write: `parallelism` alone should never need
  // --apply to answer "what is it now?".
  if (raw === undefined) {
    const only = laneFilter(ctx);
    return withApiSession(ctx, async (s) => {
      const q = narrow(await s.get<WireQueue>("/api/v4/queue"), only);
      ctx.emit(q, () => {
        const lanes = q.lanes ?? [];
        if (!lanes.length) return String(q.parallelism);
        const w = Math.max(...lanes.map((l) => l.lane.length));
        return lanes
          .map(
            (l) =>
              `${pad(l.lane, w)}  ${l.parallelism}${l.pinned ? "  (pinned)" : ""}`,
          )
          .join("\n");
      });
      return EXIT.OK;
    });
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0)
    throw usage(
      `invalid parallelism "${raw}"`,
      "concurrency must be a non-negative integer (0 unpins)",
      "run `liveone queue parallelism` to read the current values",
    );
  // 0 is the unpin spelling. The wire says `null`, but a flag that takes a number should not also
  // take the word "null", and there is no lane a cap of 0 could sensibly mean.
  const parallelism = n === 0 ? null : n;
  return patch(ctx, { parallelism }, (b, body) => {
    const target = scopeOf(body);
    if (parallelism === null) return `unpin ${target}`;
    const current =
      body.lane && body.lane !== "all"
        ? b.lanes?.find((l) => l.lane === body.lane)?.parallelism
        : b.parallelism;
    return current === parallelism
      ? `pin ${target} at ${parallelism} (already there)`
      : `set ${target} parallelism ${current ?? "?"} → ${parallelism}`;
  });
}

// ---------------------------------------------------------------------------
// timing
// ---------------------------------------------------------------------------

interface WireAttempt {
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  state: string;
  error?: string;
}

interface WireMessage {
  messageId: string;
  lane: Lane | null;
  transport: "queue" | "flow" | "unknown";
  createdAt: number | null;
  waitMs: number | null;
  attempts: WireAttempt[];
  durationMs: number | null;
  occupancyMs: number | null;
  state: string;
  settled: boolean;
  observations: number | null;
  systemId: number | null;
  error?: string;
}

interface WirePercentiles {
  p50: number | null;
  p95: number | null;
  max: number | null;
}

interface WireLog {
  window: { fromMs: number; toMs: number };
  mode: "queue" | "flow";
  messages: WireMessage[];
  summary: {
    messages: number;
    delivered: number;
    failed: number;
    inFlight: number;
    retries: number;
    durationMs: WirePercentiles;
    waitMs: WirePercentiles;
    occupancyMs: WirePercentiles;
    byTransport: { queue: number; flow: number; unknown: number };
  };
  truncated: boolean;
  covered: { fromMs: number; toMs: number } | null;
  foreign: number;
}

/** Milliseconds, at a width a human can scan. `null` renders as a dash, never as 0. */
const ms = (v: number | null): string => {
  if (v === null) return "—";
  if (v < 1000) return `${v}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)}s`;
  return `${Math.floor(v / 60_000)}m${String(Math.round((v % 60_000) / 1000)).padStart(2, "0")}s`;
};

const clock = (t: number | null): string =>
  t === null ? "—" : new Date(t).toISOString().slice(11, 23);

const pct = (p: WirePercentiles): string =>
  `p50 ${ms(p.p50)}  p95 ${ms(p.p95)}  max ${ms(p.max)}`;

function renderTiming(w: WireLog, shown: WireMessage[]): string {
  const out: string[] = [
    `window       ${new Date(w.window.fromMs).toISOString()} → ${new Date(w.window.toMs).toISOString()}  (mode: ${w.mode})`,
    `batches      ${w.summary.messages}  —  ${w.summary.delivered} delivered · ${w.summary.failed} failed · ${w.summary.inFlight} in flight · ${w.summary.retries} retries`,
    `duration     ${pct(w.summary.durationMs)}`,
    `wait         ${pct(w.summary.waitMs)}`,
    `occupancy    ${pct(w.summary.occupancyMs)}`,
  ];
  const t = w.summary.byTransport;
  if (t.flow && t.queue)
    out.push(
      `transport    ${t.queue} queue · ${t.flow} flow  (coexistence window)`,
    );

  if (shown.length) {
    out.push(
      "",
      "created       lane      obs   wait      duration  try  outcome",
    );
    for (const m of shown) {
      out.push(
        [
          clock(m.createdAt).padEnd(13),
          (m.lane ?? "—").padEnd(9),
          String(m.observations ?? "—").padStart(5),
          ms(m.waitMs).padStart(8),
          ms(m.durationMs).padStart(10),
          String(m.attempts.length).padStart(4),
          "  " + m.state + (m.error ? ` — ${m.error.slice(0, 60)}` : ""),
        ].join(" "),
      );
    }
    if (shown.length < w.summary.messages)
      out.push(
        `(${shown.length} of ${w.summary.messages} shown — raise --limit, or narrow the window)`,
      );
  } else {
    out.push("", "(no batches in this window)");
  }

  // 🛑 Both of these change how the numbers above must be read, so they go BELOW them, where a
  // reader ends up, rather than above where a header is skimmed.
  if (w.truncated) {
    out.push(
      "",
      "TRUNCATED — the read budget ran out before the window did. Every count above is an",
      "undercount; narrow the window rather than trusting it.",
    );
    // Paging walks backwards from the newest row, so what survived is the RECENT end. Naming the
    // span actually read is the difference between a partial answer and a misleading one.
    if (w.covered)
      out.push(
        `Only ${new Date(w.covered.fromMs).toISOString()} → ${new Date(w.covered.toMs).toISOString()} was read.`,
      );
  }
  if (w.foreign)
    out.push(
      `(${w.foreign} log rows in this window belong to something other than observations ingest)`,
    );
  return out.join("\n");
}

async function runTiming(ctx: Ctx): Promise<number> {
  const last = str(ctx, "last");
  const from = str(ctx, "from");
  const to = str(ctx, "to");
  if (last !== undefined && from !== undefined)
    throw usage(
      "--last and --from are mutually exclusive",
      "one names a window ending now, the other a fixed window",
      "drop one of them",
    );
  if (to !== undefined && from === undefined)
    throw usage(
      "--to needs --from",
      "a window end with no start would be unbounded, and this read pages through QStash",
      "pass --from, or use --last for a window ending now",
    );

  const rawLimit = str(ctx, "limit");
  const limit = rawLimit === undefined ? 20 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1)
    throw usage(
      `invalid --limit "${rawLimit}"`,
      "the number of batches to show must be a positive integer",
      "omit it for the default of 20",
    );

  const lane = str(ctx, "lane");
  const query = new URLSearchParams();
  if (from !== undefined) query.set("from", from);
  if (to !== undefined) query.set("to", to);
  if (from === undefined) query.set("last", last ?? "1h");
  if (lane !== undefined && lane !== "all") query.set("lane", lane);

  return withApiSession(ctx, async (s) => {
    const w = await s.get<WireLog>(`/api/v4/queue/timing?${query.toString()}`);
    const failedOnly = bool(ctx, "failed");
    const matching = failedOnly
      ? w.messages.filter((m) => m.settled && m.state !== "DELIVERED")
      : w.messages;
    const shown = matching.slice(0, limit);
    ctx.emit({ ...w, messages: shown }, () => renderTiming(w, shown));
    // A findings exit on failures, so `queue timing --failed || alert` composes. A truncated window is
    // also a finding: it means the answer is incomplete, which is not the same as "nothing wrong".
    return w.summary.failed > 0 || w.truncated ? EXIT.FINDINGS : EXIT.OK;
  });
}

// ---------------------------------------------------------------------------
// outbox
// ---------------------------------------------------------------------------

interface WireOutboxFailure {
  id: number;
  deviceRid: number;
  createdAt: string;
  attempts: number;
  lastError: string | null;
  observations: number | null;
  lane: string | null;
}

interface WireOutbox {
  backlog: number;
  oldestUnpublishedAt: string | null;
  oldestAgeMinutes: number | null;
  failing: number;
  published24h: number;
  failures: WireOutboxFailure[];
  reasons: { error: string; count: number }[];
}

function renderOutbox(o: WireOutbox): string {
  const out = [
    `backlog      ${o.backlog}${o.oldestAgeMinutes !== null ? `  (oldest ${o.oldestAgeMinutes} min)` : ""}`,
    `failing      ${o.failing}${o.failing ? "  ← tried and failed" : "  (nothing has failed to publish)"}`,
    `published    ${o.published24h} in the last 24h`,
  ];

  if (o.reasons.length) {
    // The reason first and whole: this is the line an operator came for, and truncating it to fit a
    // column is how a 400 with a precise message becomes "something went wrong".
    out.push("", "reasons:");
    for (const r of o.reasons) out.push(`  ${r.count}×  ${r.error}`);
  }

  if (o.failures.length) {
    out.push("", "created                   device  lane      obs  tries");
    for (const f of o.failures)
      out.push(
        `  ${f.createdAt}  ${String(f.deviceRid).padStart(6)}  ` +
          `${(f.lane ?? "—").padEnd(8)}  ${String(f.observations ?? "—").padStart(4)}  ${String(f.attempts).padStart(5)}`,
      );
    if (o.failures.length < o.failing)
      out.push(
        `(${o.failures.length} of ${o.failing} failing rows shown — raise --limit)`,
      );
  }
  return out.join("\n");
}

async function runOutbox(ctx: Ctx): Promise<number> {
  const raw = str(ctx, "limit");
  const limit = raw === undefined ? 20 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw usage(
      `invalid --limit "${raw}"`,
      "the number of failing rows to show must be an integer between 1 and 200",
      "omit it for the default of 20",
    );
  return withApiSession(ctx, async (s) => {
    const o = await s.get<WireOutbox>(`/api/v4/queue/outbox?limit=${limit}`);
    ctx.emit(o, () => renderOutbox(o));
    return o.failing > 0 ? EXIT.FINDINGS : EXIT.OK;
  });
}

const HANDLERS: Record<string, (ctx: Ctx) => Promise<number>> = {
  status: runStatus,
  outbox: runOutbox,
  timing: runTiming,
  pause: runPause,
  resume: runResume,
  parallelism: runParallelism,
};

/** Run whichever `queue` verb was selected (the LAST path element under `liveone`). */
export async function runQueue(ctx: Ctx): Promise<number> {
  const verb = ctx.subcommandPath[ctx.subcommandPath.length - 1];
  const handler = HANDLERS[verb];
  if (!handler)
    throw usage(
      `unknown queue command "${verb}"`,
      "this verb has no handler",
      "run `npm run liveone -- queue --help`",
    );
  return handler(ctx);
}
