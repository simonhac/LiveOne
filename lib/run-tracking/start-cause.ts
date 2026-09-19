/**
 * WHY a generator run started — `derived_intervals.start_cause` / `start_requested_by`.
 *
 * Decided at recompute, from STORED evidence only, because the recompute is a delete-and-reinsert:
 * a cause that could not be re-derived from what is in the database would be wiped by the next pass
 * over the day. So this reads four things, all persisted, and nothing live:
 *
 *  - `point_commands` — a start LiveOne dispatched, and who asked (`automation:au_…` or a user id);
 *  - the hub's latch, `control_run_active` — LiveOne is holding the engine on;
 *  - DSE configurable input 1, `remote_start_input` — the SP PRO's run demand, i.e. the INVERTER;
 *  - the DSE control mode, `control_mode` — "Manual" is somebody at the panel.
 *
 * 🛑 Points are found by PHYSICAL path on the device that carries the detector's SIGNAL (the DSE),
 * never by logical path. The logical one is not stable here: on prod `remote_start_input` still sits
 * at `source.generator.control`, the stem it was minted under before a manifest rename, for the same
 * reason `GENERATOR_RPM_PATHS` (lib/control/generator-ref.ts) has to list two paths. The physical
 * path is the identity `PointManager` keys on, so it is the one that cannot drift.
 *
 * 🛑 The hub's own classification, `control_state` ("running:sp-pro" …), is deliberately NOT used.
 * It is TEXT, and until the ingest fix beside this change every text reading reached
 * `point_readings` as NULL — so it has no history to classify from, while the numeric signals it is
 * built out of go back to the hub's first day. `control_mode` is text too, which is why `panel` can
 * only be answered for runs after that fix; before it, a panel start is `other`.
 *
 * What this cannot say: the inverter's own REASON (state of charge, load, its run schedule). That
 * lives only in the SP PRO's event log, which is captured on demand rather than continuously.
 */
import { and, eq, gte, inArray, lte, ne } from "drizzle-orm";
import type { planetscaleDb } from "@/lib/db/planetscale";
import { pointCommands, points } from "@/lib/db/planetscale/schema";
import { ReadingsDao } from "@/lib/readings";
import { Point, type PointId } from "@/lib/ids";
import {
  ATTRIBUTION_LEAD_MS,
  ATTRIBUTION_TAIL_MS,
  isSelfCommandedRun,
} from "@/lib/automations/exercise";

type PgDb = NonNullable<typeof planetscaleDb>;

type StartCause = "automation" | "user" | "inverter" | "panel" | "other";

export interface RunStart {
  cause: StartCause | null;
  /** The `point_commands.requested_by` of the dispatch that started it — LiveOne starts only. */
  requestedBy: string | null;
}

const UNKNOWN: RunStart = { cause: null, requestedBy: null };

/** The DSE points, by physical path. See the header for why not by logical path. */
const REMOTE_START_PATH = "remote_start_input";
const LATCH_PATH = "control_run_active";
const MODE_PATH = "control_mode";

/** The longest run the hub will latch (`generator_run_request_min` caps at 360) — see store.ts. */
const MAX_COMMANDED_RUN_MS = 360 * 60_000;

interface Sample {
  tMs: number;
  value: number | null;
  valueStr: string | null;
}

interface Command {
  requestedAtMs: number;
  minutes: number | null;
  requestedBy: string;
}

/** Everything `classifyRunStart` looks at, over a window covering every run being classified. */
export interface StartEvidence {
  commands: Command[];
  remoteStart: Sample[];
  latch: Sample[];
  mode: Sample[];
}

/**
 * The cause of ONE run, decided from evidence around its start.
 *
 * In order, and the order is the point:
 *  1. **A command** — the only source that names WHO. Matched by `isSelfCommandedRun`, the very
 *     rule the exercise evaluator uses to decide a run was its own, so the two can never disagree
 *     about which runs LiveOne started.
 *  2. **The inverter's demand** — input 1 closed at the start. Before the latch, because the SP PRO
 *     can demand a run the hub then also happens to hold, and the demand is what started it.
 *  3. **The latch with no command on record** — LiveOne held it on, but no row says who asked.
 *  4. **Manual mode** — somebody at the panel.
 *  5. **Evidence, but none of the above** — `other`. Distinct from NULL: the hub was reporting and
 *     nothing it reported explains the start.
 *  6. **No evidence at all** (before the hub existed, or through a dropout) — NULL, unknown.
 */
export function classifyRunStart(
  startMs: number,
  evidence: StartEvidence,
): RunStart {
  const command = evidence.commands.find((c) =>
    isSelfCommandedRun(startMs, [c]),
  );
  if (command)
    return {
      cause: command.requestedBy.startsWith("automation:")
        ? "automation"
        : "user",
      requestedBy: command.requestedBy,
    };

  const fromMs = startMs - ATTRIBUTION_LEAD_MS;
  const toMs = startMs + ATTRIBUTION_TAIL_MS;
  const around = (series: Sample[]) =>
    series.filter((s) => s.tMs >= fromMs && s.tMs <= toMs);

  const remote = around(evidence.remoteStart);
  const latch = around(evidence.latch);
  const mode = around(evidence.mode);

  if (remote.some((s) => s.value === 1))
    return { cause: "inverter", requestedBy: null };
  if (latch.some((s) => s.value === 1))
    return { cause: "other", requestedBy: null };
  if (mode.some((s) => s.valueStr === "Manual"))
    return { cause: "panel", requestedBy: null };

  const reported = [...remote, ...latch, ...mode].some(
    (s) => s.value !== null || s.valueStr !== null,
  );
  return reported ? { cause: "other", requestedBy: null } : UNKNOWN;
}

/**
 * Load the evidence for every run start in [fromMs, toMs], or null when the detector's signal
 * device carries none of the DSE points — i.e. a generator this does not know how to read, whose
 * runs are then stored with an unknown cause rather than a guessed one.
 *
 * Read on the POOL, for the same reason the recompute resolves intensity there: read-only side
 * tables this transaction neither reads for correctness nor writes.
 */
export async function loadStartEvidence(
  db: PgDb,
  signalPoint: PointId,
  fromMs: number,
  toMs: number,
): Promise<StartEvidence | null> {
  const [signal] = await db
    .select({ deviceId: points.deviceId })
    .from(points)
    .where(eq(points.id, Point.toUuid(signalPoint)))
    .limit(1);
  if (!signal) return null;

  const found = await db
    .select({ id: points.id, physicalPath: points.physicalPath })
    .from(points)
    .where(
      and(
        eq(points.deviceId, signal.deviceId),
        inArray(points.physicalPath, [
          REMOTE_START_PATH,
          LATCH_PATH,
          MODE_PATH,
        ]),
      ),
    );
  if (found.length === 0) return null;
  const byPath = new Map(
    found.map((p) => [p.physicalPath, Point.encode(p.id)]),
  );

  const window = {
    fromMs: fromMs - ATTRIBUTION_LEAD_MS,
    toMs: toMs + ATTRIBUTION_TAIL_MS,
  };
  const ids = [...byPath.values()];
  const series = await ReadingsDao.readRaw(ids, window);
  const samples = (path: string): Sample[] => {
    const id = byPath.get(path);
    return id
      ? (series.get(id) ?? []).map((r) => ({
          tMs: r.measurementTimeMs,
          value: r.value,
          valueStr: r.valueStr,
        }))
      : [];
  };

  // Every non-rejected dispatch on the DEVICE that could have started a run in the window — the
  // same inclusion rule as `ownCommandsInWindow` (store.ts), and for its reason: a `failed` start
  // "MAY have taken effect", so only a refusal is known to have started nothing.
  const commands = await db
    .select({
      requestedAt: pointCommands.requestedAt,
      value: pointCommands.value,
      requestedBy: pointCommands.requestedBy,
    })
    .from(pointCommands)
    .where(
      and(
        eq(pointCommands.deviceId, signal.deviceId),
        eq(pointCommands.action, "set_value"),
        ne(pointCommands.status, "rejected"),
        gte(
          pointCommands.requestedAt,
          new Date(fromMs - MAX_COMMANDED_RUN_MS - ATTRIBUTION_TAIL_MS),
        ),
        lte(pointCommands.requestedAt, new Date(toMs + ATTRIBUTION_LEAD_MS)),
      ),
    );

  return {
    commands: commands.map((c) => ({
      requestedAtMs: c.requestedAt.getTime(),
      minutes: c.value,
      requestedBy: c.requestedBy,
    })),
    remoteStart: samples(REMOTE_START_PATH),
    latch: samples(LATCH_PATH),
    mode: samples(MODE_PATH),
  };
}
