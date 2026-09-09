/**
 * The `queue` domain of the `liveone` CLI — the observations ingest queue: is it flowing, and if
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
 */
import { defineCommand, EXIT, type CommandSpec, type Ctx } from "@/lib/cli/cli";
import { withApiSession } from "@/lib/cli-kit/api-session";
import { apiFetch } from "@/lib/cli-kit/http";
import { BASE_URL_FLAG, usage } from "../shared";

interface WireQueue {
  name: string;
  paused: boolean;
  lag: number;
  parallelism: number;
  lastIngestedAt: string | null;
  stalledMinutes: number | null;
}

/**
 * How many minutes without a durable write before `status` calls it a finding.
 *
 * Steady state is ~43 observations/minute across every device, so a gap this long is not a quiet
 * period — it is a stall. Deliberately generous relative to the one-minute poll: a single slow
 * message must not page.
 */
const STALL_THRESHOLD_MIN = 5;

const render = (q: WireQueue): string => {
  const stalled =
    q.stalledMinutes == null
      ? "never ingested"
      : `${q.stalledMinutes} min since last ingest`;
  return [
    `queue        ${q.name}${q.paused ? "  PAUSED" : ""}`,
    `lag          ${q.lag}`,
    `parallelism  ${q.parallelism}`,
    `last ingest  ${q.lastIngestedAt ?? "(none)"}  — ${stalled}`,
  ].join("\n");
};

export const queueCommand = defineCommand({
  name: "queue",
  summary:
    "The observations ingest queue — status, and the levers to unblock it.",
  when:
    "Reach for this when readings have stopped arriving, or before and after a large backfill.\n" +
    "`status` is the one-line health read; `parallelism` is the lever that clears a stall.",
  description:
    "Admin-only, http-only. Prints `target: <origin> as <you>` on stderr first.\n\n" +
    "READ `stalled`, NOT `lag`. A rising lag is ambiguous — a busy queue and a blocked one both\n" +
    "grow — and it was misread twice during the 2026-09-09 stall. Minutes since the last durable\n" +
    "write is not ambiguous: a busy queue still ingests.",
  uses: ["api"],
  subcommands: {
    status: {
      name: "status",
      summary:
        "Is ingest flowing? Reports lag, parallelism, and minutes since the last durable write.",
      when: "Start here. Exits 1 (findings) when ingest has stalled, so it composes into a check.",
      flags: { ...BASE_URL_FLAG },
      examples: ["liveone queue status"],
    },
    pause: {
      name: "pause",
      summary:
        "Stop the queue dispatching. Messages accumulate; nothing is lost.",
      when:
        "Use this to stop delivery while you diagnose, or before a change that would make the\n" +
        "receiver fail. Publishing is unaffected — the outbox keeps accepting.",
      mutates: true,
      flags: { ...BASE_URL_FLAG },
      examples: ["liveone queue pause --apply"],
    },
    resume: {
      name: "resume",
      summary: "Resume dispatching after a pause.",
      when: "The inverse of `pause`.",
      mutates: true,
      flags: { ...BASE_URL_FLAG },
      examples: ["liveone queue resume --apply"],
    },
    parallelism: {
      name: "parallelism",
      summary:
        "Read, or set, how many messages the queue delivers concurrently. Capped by the PG pool.",
      when:
        "Raise this when one slow message is head-of-line blocking every device. With no\n" +
        "argument it reads the current value and writes nothing.",
      mutates: true,
      args: [
        {
          name: "n",
          required: false,
          help: "New concurrency, 1..PLANETSCALE_POOL_MAX (default 10). Omit to read.",
        },
      ],
      flags: { ...BASE_URL_FLAG },
      examples: [
        "liveone queue parallelism",
        "liveone queue parallelism 5 --apply",
      ],
    },
  },
} satisfies CommandSpec);

async function runStatus(ctx: Ctx): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const q = await s.get<WireQueue>("/api/v4/queue");
    const stalled =
      q.stalledMinutes != null && q.stalledMinutes > STALL_THRESHOLD_MIN;
    ctx.emit(q, () =>
      stalled
        ? `${render(q)}\n\nSTALLED — no durable write for ${q.stalledMinutes} min (threshold ${STALL_THRESHOLD_MIN}).`
        : render(q),
    );
    // A finding, not an error: the command did its job. `liveone queue status || alert` composes.
    return stalled ? EXIT.FINDINGS : EXIT.OK;
  });
}

/** PATCH the queue, or — when dry — report what would change without touching it. */
async function patch(
  ctx: Ctx,
  body: { paused?: boolean; parallelism?: number },
  describe: (before: WireQueue) => string,
): Promise<number> {
  return withApiSession(ctx, async (s) => {
    const before = await s.get<WireQueue>("/api/v4/queue");
    if (ctx.dryRun) {
      ctx.emit(
        { ...before, applied: false, would: body },
        () =>
          `${render(before)}\n\nwould ${describe(before)}\n(dry run — pass --apply to write)`,
      );
      return EXIT.OK;
    }
    const { body: after } = await apiFetch<WireQueue>(
      s.origin,
      "/api/v4/queue",
      { method: "PATCH", body, token: s.token },
    );
    ctx.emit({ ...after, applied: true }, () => render(after));
    return EXIT.OK;
  });
}

const runPause = (ctx: Ctx) =>
  patch(ctx, { paused: true }, (b) =>
    b.paused ? "leave it paused" : "pause the queue",
  );

const runResume = (ctx: Ctx) =>
  patch(ctx, { paused: false }, (b) =>
    b.paused ? "resume the queue" : "leave it running",
  );

async function runParallelism(ctx: Ctx): Promise<number> {
  const raw = ctx.args[0];
  // No argument is a READ, and must not be a no-op write: `parallelism` alone should never need
  // --apply to answer "what is it now?".
  if (raw === undefined) {
    return withApiSession(ctx, async (s) => {
      const q = await s.get<WireQueue>("/api/v4/queue");
      ctx.emit(q, () => String(q.parallelism));
      return EXIT.OK;
    });
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw usage(
      `invalid parallelism "${raw}"`,
      "concurrency must be a positive integer",
      "run `liveone queue parallelism` to read the current value",
    );
  return patch(ctx, { parallelism: n }, (b) =>
    b.parallelism === n
      ? `leave parallelism at ${n}`
      : `set parallelism ${b.parallelism} → ${n}`,
  );
}

const HANDLERS: Record<string, (ctx: Ctx) => Promise<number>> = {
  status: runStatus,
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
