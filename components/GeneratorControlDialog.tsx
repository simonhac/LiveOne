"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Minus,
  Play,
  RefreshCw,
  Square,
  XCircle,
} from "lucide-react";
import { queryKeys } from "@/lib/queries/keys";
import { measurementMsOf } from "@/lib/control/point-ref";
import { describeDecline } from "@/lib/control/decline-copy";
import { GENERATOR_RUN_REQUEST_ADDRESS } from "@/lib/control/addresses";
import {
  GENERATOR_ERROR_PATH,
  GENERATOR_MODE_PATH,
  GENERATOR_STATUS_PATH,
  GENERATOR_STOP_AT_PATH,
  describeGeneratorState,
  generatorRunRequestTarget,
  runMinutesLeft,
} from "@/lib/control/generator-ref";
import ControlNotice, {
  type ControlNoticeValue,
} from "@/components/ControlNotice";
import CommandActivityLog from "@/components/CommandActivityLog";
import type { LatestPointValues } from "@/lib/types/api";
import {
  renderMessageLike,
  type StructuredMessage,
} from "@/lib/control/message-format";
import { formatSecondsAsDuration, formatTime12h } from "@/lib/fe-date-format";

/** The `POST …/preflight` body — mirrors `ControlPreflightResult` (lib/vendors/types.ts). */
interface PreflightJson {
  ok: boolean;
  wouldProceed?: boolean;
  /** The hub's own sentence. Rendered VERBATIM — see the 🛑 on the verdict line below. */
  verdict: string;
  /** `verdict` unrendered, when it names an instant — see lib/control/message-format.ts. */
  verdictMessage?: StructuredMessage;
  checks?: { label: string; value: string; ok: boolean | null }[];
  /** DeepSea puts everything the probe read here, flat — the freshest word on the generator. */
  detail?: {
    maxRuntimeSec?: number;
    latched?: boolean;
    stopAt?: string | null;
    /**
     * `RunSupervisor.state()` — byte-identical to the pushed `…control.status/state` point, because
     * it is the same call. This is what lets a probe re-answer the header's question.
     */
    state?: string;
    /** The DSE panel mode as a word ("Auto", "Stop"), which `describeGeneratorState` needs to tell
     *  an ARMED idle generator from a LOCKED OUT one. */
    modeName?: string | null;
  } | null;
}

/**
 * The point's own `control` descriptor bound (lib/control/control-registry.ts:
 * `{kind:"number", min:0, max:360, step:5}`).
 *
 * 🛑 This is the UI/plausibility bound, NOT the safety bound. The hub's `maxRuntimeSec` is the one
 * actually enforced where the latch is held, the two are deliberately independent, and the slider
 * clamps DOWN to whichever the preflight reports. A mistake here cannot widen what will run.
 */
const DESCRIPTOR_MAX_MIN = 360;
const STEP_MIN = 5;

/**
 * The preset chips.
 *
 * Labelled explicitly rather than derived, because the spoken form of a preset is not the spoken
 * form of a duration: 90 minutes is offered as "1.5h" (one chip, one glance) where the sentences
 * below call the same run "1h 30m" via `formatSecondsAsDuration`. Every value is a multiple of
 * `STEP_MIN` so a chip always lands exactly on a slider stop.
 */
const PRESETS: { min: number; label: string }[] = [
  { min: 5, label: "5m" },
  { min: 15, label: "15m" },
  { min: 30, label: "30m" },
  { min: 60, label: "1h" },
  { min: 90, label: "1.5h" },
  { min: 120, label: "2h" },
  { min: 180, label: "3h" },
  { min: 240, label: "4h" },
  { min: 360, label: "6h" },
];
const DEFAULT_MIN = 30;

/** "30m", "1h 30m", "6h" — the house duration spelling, for the sentences around the slider. */
function runWords(minutes: number): string {
  return formatSecondsAsDuration(minutes * 60);
}

/** How long after an ambiguous send before we re-probe to find out what actually happened. */
const AMBIGUITY_RECHECK_MS = 5_000;

/**
 * This dialog's width — declared once, and handed BOTH to its own DialogContent and to the activity
 * log's "Show more" modal, which opens on top of it. Two literals would let the stack resize as you
 * open the trail; one constant cannot.
 */
const DIALOG_WIDTH = "sm:max-w-md";

/**
 * The house 12-hour spelling of an absolute instant ("12:03am"), in the BROWSER's zone — the clock
 * the reader is looking at while the engine runs. Absolute, so no offset arithmetic is needed.
 */
function clockWords(ms: number): string {
  const d = new Date(ms);
  return formatTime12h({ hour: d.getHours(), minute: d.getMinutes() });
}

function text(latest: LatestPointValues | null, path: string): string | null {
  const v = latest?.[path]?.value as unknown;
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(latest: LatestPointValues | null, path: string): number | null {
  const v = latest?.[path]?.value as unknown;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

interface GeneratorControlDialogProps {
  /** The DEVICE (or area) handle whose `/api/data` this dialog invalidates after a command. */
  systemId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  latest: LatestPointValues | null;
}

/**
 * Generator run controls — opened from the cog on the generator tile.
 *
 * Commands go through the generic command plane exactly as the Tesla dialog's do:
 * `POST /api/v4/points/{pt_}/action {action:"set_value", value:<MINUTES>}`, where 0 stops. The
 * target `pt_` comes from the `pointReference` the latest-values map already carries — nothing is
 * hardcoded.
 *
 * ## What is different from the charge dialog, and why
 *
 * - **Start is GATED on a live preflight.** `TeslaControlDialog` deliberately never disables
 *   Start/Stop, because a redundant press there is a benign decline plus a free re-poll. Here the
 *   worst case is a diesel engine running that nobody meant to start, so Start stays disabled until
 *   the hub's `noop` — the whole chain, FC3 reads only, decided by the same `gateStart()` a real
 *   run consults — says a run would be accepted. The refusal shown is the hub's own sentence; this
 *   dialog never forms a second opinion about whether a start is safe.
 * - **Stop is never gated**, which IS the Tesla rule: releasing the latch has to stay reachable when
 *   our picture is stale, when the probe failed, and especially when something has gone wrong.
 * - **There is no Refresh button.** DeepSea is a push vendor; there is nothing for the web tier to
 *   re-poll, and the preflight *is* the fresh read.
 * - **`released ≠ stopped`.** A stop that only cleared our latch comes back from the vendor as a
 *   200 with a `reason` explaining that the inverter is still calling for the engine. That renders
 *   as an informational notice, never a success tick.
 */
export default function GeneratorControlDialog({
  systemId,
  open,
  onOpenChange,
  latest,
}: GeneratorControlDialogProps) {
  const queryClient = useQueryClient();

  const target = generatorRunRequestTarget(latest);
  const state = text(latest, GENERATOR_STATUS_PATH);
  const mode = text(latest, GENERATOR_MODE_PATH);
  const lastError = text(latest, GENERATOR_ERROR_PATH);
  const stopAtSec = num(latest, GENERATOR_STOP_AT_PATH);
  const statusMs = measurementMsOf(latest, GENERATOR_STATUS_PATH);

  const [minutes, setMinutes] = useState<number>(DEFAULT_MIN);
  const [notice, setNotice] = useState<ControlNoticeValue | null>(null);
  const [pending, setPending] = useState<"start" | "extend" | "stop" | null>(
    null,
  );
  // Ticks the countdown between 15 s pushes; `stop_at` is absolute so nothing is re-fetched.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    // 🛑 Re-seed on OPEN, not only on the interval. This component stays MOUNTED (with `open`
    // false) inside the generator tile's overlay for as long as the dashboard is up, so the
    // initializer above runs at PAGE LOAD — on a dashboard left open an hour, `nowMs` is an hour
    // stale, and the first interval tick is another 5 s away. Every clock in this dialog derives
    // from it, including the Extend button's projected stop time, which is a forward projection
    // and so wrong by the full staleness rather than self-correcting.
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 5_000);
    return () => clearInterval(t);
  }, [open]);

  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(
    () => () => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
    },
    [],
  );

  // ── the preflight ────────────────────────────────────────────────────────
  //
  // Fired unconditionally on open (unlike the Tesla dialog's staleness-gated refresh): it costs no
  // vendor money, cannot wake or move hardware, and answering "is it safe to start this" is the
  // reason the dialog exists. `useQuery` rather than a mutation so "Check again" is a refetch and
  // the in-flight state is free — but with no interval: this is a probe, not a poll.
  const preflight = useQuery({
    queryKey: ["generator-preflight", target ?? ""],
    queryFn: async (): Promise<PreflightJson> => {
      // 🛑 No `value`, and the chosen duration is deliberately NOT in the query key. The probe
      // asks about the MOMENT: every runtime this dialog can offer is already clamped to the hub's
      // `maxRuntimeSec` (see `maxMin` below), and that cap was the only runtime-dependent term in
      // `gateStart()` — so the verdict cannot change with the slider, and keying on it would fire
      // a Modbus round-trip over WireGuard per slider step. The hub no longer accepts a proposed
      // runtime at all, which is what lets its verdict be shown as written.
      const res = await fetch(`/api/v4/points/${target}/preflight`, {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Could not check the engine");
      return body as PreflightJson;
    },
    enabled: open && !!target,
    // A probe answers about a MOMENT. Nothing may serve a cached verdict about whether it is safe
    // to start an engine, so every open re-asks.
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });

  // ── whose picture of the generator wins ──────────────────────────────────
  //
  // `latest` is a pushed point: up to one hub poll old, behind a 30 s browser refetch. The probe is
  // a live Modbus read that answers the SAME question — its `detail.state` is `RunSupervisor.
  // state()`, the very call that produces the pushed point. So "Check again" was returning a fresher
  // answer to the question the header asks and then throwing it away: press it on a generator that
  // had since started, and the sentence still read "Stopped, and armed to start automatically · as
  // of 3 min ago".
  //
  // `dataUpdatedAt` is React Query's own receipt time, so it is right after a refetch that returned
  // identical bytes, and it needs no state of its own.
  const probeMs = preflight.data?.detail?.state
    ? preflight.dataUpdatedAt
    : null;
  const useProbe = probeMs != null && (statusMs == null || probeMs > statusMs);
  const status = useProbe
    ? describeGeneratorState(
        preflight.data!.detail!.state,
        preflight.data!.detail!.modeName ?? mode,
      )
    : describeGeneratorState(state, mode);

  // The ceiling that is actually enforced, once the hub has told us. Until then the point's own
  // descriptor bound stands. `Math.min` on purpose: whichever is lower wins, always.
  const hubMaxMin = preflight.data?.detail?.maxRuntimeSec
    ? Math.floor(preflight.data.detail.maxRuntimeSec / 60)
    : null;
  const maxMin = Math.max(
    STEP_MIN,
    Math.min(DESCRIPTOR_MAX_MIN, hubMaxMin ?? DESCRIPTOR_MAX_MIN),
  );
  useEffect(() => {
    setMinutes((m) => Math.min(m, maxMin));
  }, [maxMin]);

  // Prefer the PROBE's deadline when it has one: it is a live read, where the pushed point is up
  // to 15 s old — which is exactly the window right after a Start, when the countdown matters most.
  const probeStopAtSec = preflight.data?.detail?.stopAt
    ? Date.parse(preflight.data.detail.stopAt) / 1000
    : null;
  const minsLeft = runMinutesLeft(probeStopAtSec ?? stopAtSec, nowMs);
  // Either source may be the fresher one, so a run in progress according to EITHER is a run in
  // progress. Getting this wrong in the optimistic direction would offer Start for a running engine.
  const runInProgress =
    status.isCommandedRun || preflight.data?.detail?.latched === true;
  const canStart =
    preflight.data?.ok === true && preflight.data.wouldProceed === true;

  function scheduleDataRefresh() {
    // The push cadence is 15 s, so the backstop sits one tick past it — an early look for the
    // fast case, and a second that is guaranteed to be after a fresh push has landed.
    for (const delay of [6_000, 20_000]) {
      timersRef.current.push(
        setTimeout(() => {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.data(systemId),
          });
        }, delay),
      );
    }
  }

  const mutation = useMutation({
    mutationFn: async ({ value }: { key: typeof pending; value: number }) => {
      const response = await fetch(`/api/v4/points/${target}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_value", value }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Command failed");
      return data as {
        ok: boolean;
        reason: string | null;
        reasonMessage?: StructuredMessage;
      };
    },
    onMutate: ({ key }) => {
      setNotice(null);
      setPending(key);
    },
    onSuccess: async (data) => {
      // 🛑 Both legs carry the vendor's own words. On the success leg that matters as much as on
      // the decline: "Released the hub's run request, but the engine is still running — it is being
      // commanded by the SP-PRO inverter, which this control cannot override" arrives as ok:true,
      // and swallowing it in favour of a tick would tell the user the engine had stopped.
      if (data.reason) {
        // Prefer the template when the vendor sent one: its instant is spelled in the reader's
        // clock, where `reason` carries ISO so the audit row stays unambiguous.
        const spoken =
          renderMessageLike(data.reasonMessage ?? data.reason) ?? data.reason;
        setNotice({
          tone: "info",
          text: data.ok
            ? spoken
            : describeDecline(
                "set_value",
                spoken,
                GENERATOR_RUN_REQUEST_ADDRESS,
              ).text,
        });
      }
      scheduleDataRefresh();
      await queryClient.invalidateQueries({
        queryKey: queryKeys.data(systemId),
      });
      if (target) {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.commands(target),
        });
      }
      void preflight.refetch();
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : "Command failed";
      setNotice({ tone: "error", text: message });
      // 🛑 An ambiguous send is never "nothing happened". `hub-client.ts` answers a timeout with a
      // message saying the start MAY have taken effect, so go and find out rather than leaving the
      // user with a red box and no facts. Harmless in the ordinary error case: it is a read.
      timersRef.current.push(
        setTimeout(() => {
          void preflight.refetch();
          void queryClient.invalidateQueries({
            queryKey: queryKeys.data(systemId),
          });
        }, AMBIGUITY_RECHECK_MS),
      );
    },
    onSettled: () => setPending(null),
  });

  // A fresh open should not inherit the last visit's notice.
  useEffect(() => {
    if (!open) setNotice(null);
  }, [open]);

  const busy = mutation.isPending;
  // Only the runtimes the hub would actually accept — see `maxMin`.
  const presets = PRESETS.filter((p) => p.min <= maxMin);
  // Reads the PROBE's deadline first for the same reason `minsLeft` does, and reading a different
  // one would be worse than either: the two sit in one sentence ("stops at 3:05pm (12 min left)"),
  // so sourcing them differently lets them contradict each other.
  const deadlineSec = probeStopAtSec ?? stopAtSec;
  const stopsAtWords =
    deadlineSec != null ? clockWords(deadlineSec * 1000) : null;
  /**
   * The deadline an Extend would SET — and the whole reason the button names a clock time.
   *
   * 🛑 The hub recomputes the deadline from NOW (`setDeadline(runtimeSec)` on an already-latched
   * run), so "Extend · 30m" means "run until 30 minutes from now", NOT "add 30 minutes to what is
   * left". Those differ by the remaining time, and on a run with 24 minutes left the two readings
   * are 30 minutes apart — which is exactly the ambiguity a duration label cannot resolve. An
   * absolute instant has only one meaning, and it sits directly under the current "stops at …", so
   * the reader compares the old deadline with the new one rather than doing the arithmetic.
   */
  const extendToWords = clockWords(nowMs + minutes * 60_000);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 🛑 No auto-focus. Radix focuses the first tabbable descendant, which lands a focus ring on
          "Check again" — or, while the probe is still in flight and that button is disabled, on the
          FIRST duration chip. That read as "5m is selected" next to an actually-selected 30m, which
          is the one thing this dialog must not be ambiguous about. Nothing here wants focus on open;
          Escape and the close button work regardless. */}
      <DialogContent
        className={DIALOG_WIDTH}
        onOpenAutoFocus={(e) => e.preventDefault()}
        // There is no DialogDescription any more, so tell Radix not to look for one.
        aria-describedby={undefined}
      >
        <DialogHeader>
          {/* The status sentence used to live here. It came from the same probe the Engine check
              panel below renders, so it said nothing that panel does not — and on a phone those two
              lines were the difference between the dialog fitting and not. */}
          <DialogTitle>Generator control</DialogTitle>
        </DialogHeader>

        <div className="mt-2 space-y-5">
          {/* The hub's own last error, if any. Above everything, because it changes how to read
              everything below it. */}
          {lastError && (
            <div className="rounded-md border border-red-800/70 bg-red-950/30 px-3 py-2 text-xs text-red-300">
              {/* A text POINT value, so there is no template to carry — the instant localizer is
                  the only lever, and it is enough: it rewrites the ISO and nothing else. */}
              {renderMessageLike(lastError)}
            </div>
          )}

          {/* ── Engine check ────────────────────────────────────────────── */}
          <section className="rounded-md border border-gray-700 bg-gray-900/40 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-gray-300">
                Engine check
              </span>
              {/* Outline, matching the activity log's "Show more" — the dialog's two small utility
                  buttons should read as one family rather than as a link and a button. */}
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                disabled={preflight.isFetching || !target}
                onClick={() => void preflight.refetch()}
              >
                {preflight.isFetching ? (
                  <>
                    <RefreshCw className="mr-1 h-3 w-3 animate-spin" />
                    checking…
                  </>
                ) : (
                  "Check again"
                )}
              </Button>
            </div>

            {!target ? (
              // The point exists but KV has not carried its `pt_` yet (a device that has not pushed
              // since the deploy). Self-heals on the next 15 s tick; say so rather than showing a
              // dead button.
              <p className="text-xs text-gray-400">
                Waiting for the generator to report in.
              </p>
            ) : preflight.isLoading ? (
              <EngineCheckSkeleton />
            ) : preflight.isError ? (
              <p className="text-xs text-red-400">
                {preflight.error instanceof Error
                  ? preflight.error.message
                  : "Could not check the engine."}
              </p>
            ) : (
              <>
                <ul className="space-y-1 text-xs">
                  {(preflight.data?.checks ?? []).map((c) => (
                    <li key={c.label} className="flex items-center gap-2">
                      {c.ok === true ? (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-500" />
                      ) : c.ok === false ? (
                        <XCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />
                      ) : (
                        <Minus className="h-3.5 w-3.5 shrink-0 text-gray-500" />
                      )}
                      <span className="w-32 shrink-0 text-gray-400">
                        {c.label}
                      </span>
                      <span className="text-gray-200">{c.value}</span>
                    </li>
                  ))}
                </ul>
                {/* 🛑 THE HUB'S SENTENCE, VERBATIM — acceptance and refusal alike. It is produced
                    by the same `gateStart()` a real run consults, and it is written to be read by a
                    human ("Ready to start"; "A run would be refused: the module is not in Auto
                    (mode=Stop) — a possible local lockout at the panel, and not overridable
                    remotely"). This dialog forms no second opinion and writes no sentence of its own.

                    The acceptance used to be an exception: the dialog threw the hub's verdict away
                    and printed "Ready — a 15m run would start now." That was not a wording
                    preference. The hub was being asked about a 60-second run invented by three
                    layers of default, so its answer named a length nobody had proposed, and the
                    only way to show it was to replace it. The probe now asks about the MOMENT
                    (see the query above), so the hub's own answer is the true one and the chosen
                    length lives where it belongs — on the selected chip and on the Start button.

                    Colour and icon still key off `wouldProceed`. That is presentation, not words. */}
                {preflight.data && (
                  <p
                    className={`mt-2 flex min-h-[2rem] items-start gap-1.5 text-xs ${
                      canStart ? "text-green-500/90" : "text-amber-400/90"
                    }`}
                  >
                    {canStart ? (
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    )}
                    <span>
                      {renderMessageLike(
                        preflight.data.verdictMessage ?? preflight.data.verdict,
                      ) ?? preflight.data.verdict}
                    </span>
                  </p>
                )}
              </>
            )}
          </section>

          <ControlNotice notice={notice} onDismiss={() => setNotice(null)} />

          {/* ── Duration ────────────────────────────────────────────────── */}
          <div className="space-y-2">
            {/* Static: the chosen length is on the selected chip and again on the Start button, so
                repeating it here was a third copy that moved as you dragged. */}
            <Label htmlFor="generator-minutes">Run time</Label>
            {/* One row, spanning the slider's full width: an equal-fraction grid rather than a
                wrapping flex, so the chips end flush with both ends of the track below them and
                the run lengths read as one scale. `min-w-0` + `px-0` let a chip shrink below its
                label's natural padding instead of overflowing the grid. */}
            <div
              className="grid gap-1"
              style={{
                gridTemplateColumns: `repeat(${presets.length}, minmax(0, 1fr))`,
              }}
            >
              {presets.map((p) => (
                <Button
                  key={p.min}
                  type="button"
                  size="sm"
                  variant={p.min === minutes ? "default" : "outline"}
                  className="h-7 min-w-0 px-0 text-xs"
                  disabled={busy}
                  onClick={() => setMinutes(p.min)}
                >
                  {p.label}
                </Button>
              ))}
            </div>
            <input
              id="generator-minutes"
              type="range"
              min={STEP_MIN}
              max={maxMin}
              step={STEP_MIN}
              value={minutes}
              disabled={busy}
              onChange={(e) => setMinutes(parseInt(e.target.value, 10))}
              className="w-full accent-amber-500"
            />
          </div>

          {/* ── The command ─────────────────────────────────────────────── */}
          {runInProgress ? (
            <div className="space-y-2">
              <p className="text-sm text-amber-400/90">
                Running
                {stopsAtWords ? ` · stops at ${stopsAtWords}` : ""}
                {minsLeft != null ? ` (${runWords(minsLeft)} left)` : ""}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  disabled={busy || !target}
                  onClick={() =>
                    mutation.mutate({ key: "extend", value: minutes })
                  }
                >
                  {pending === "extend" ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="mr-2 h-4 w-4" />
                  )}
                  Extend · to {extendToWords}
                </Button>
                {/* 🛑 Never disabled on the preflight. Letting go of the latch must stay reachable
                    when our picture is stale or the probe itself failed. */}
                <Button
                  variant="outline"
                  className="flex-1"
                  disabled={busy || !target}
                  onClick={() => mutation.mutate({ key: "stop", value: 0 })}
                >
                  {pending === "stop" ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Square className="mr-2 h-4 w-4" />
                  )}
                  Stop
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button
                className="flex-1"
                disabled={busy || !target || !canStart}
                onClick={() =>
                  mutation.mutate({ key: "start", value: minutes })
                }
              >
                {pending === "start" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Play className="mr-2 h-4 w-4" />
                )}
                Start · {runWords(minutes)}
              </Button>
              {/* Same command as the Stop above (`value: 0`), and the same 🛑: never gated on the
                  preflight, because a start whose response was LOST leaves the hub latched while
                  this dialog still shows the idle branch, and this is the only way out of that.
                  It is normally a no-op, which is why it is not a peer of Start visually.

                  🛑 The label says "Stop", but this branch also renders during a `running:sp-pro`
                  run, where our command clears only OUR latch and cannot end the inverter's run.
                  Nothing is hidden — the header sentence above says exactly that, and the vendor's
                  own reply after the press says it again — but the LABEL no longer carries it, so
                  it is written here instead. */}
              <Button
                variant="outline"
                className="flex-1"
                disabled={busy || !target}
                onClick={() => mutation.mutate({ key: "stop", value: 0 })}
              >
                {pending === "stop" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Square className="mr-2 h-4 w-4" />
                )}
                Stop
              </Button>
            </div>
          )}

          <CommandActivityLog pt={target} modalWidthClass={DIALOG_WIDTH} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The engine check at its FINAL height, before the probe answers.
 *
 * The box used to paint one line ("Reading the controller…") and then grow to its rows plus a
 * verdict, which moved every control below it just as the user reached for one. The height is
 * knowable: `probeChecks` (lib/vendors/deepsea/control.ts) returns exactly three checks, always
 * — one per fact the DSE is asked about — so the skeleton is three rows and not a guess. Move that
 * count and this must move with it, or the jump comes back.
 *
 * It mirrors the real `<li>` markup rather than approximating it, so the two cannot drift out of
 * alignment: same `space-y-1`, same `h-3.5 w-3.5` status glyph, same `w-32` label column, and the
 * same `min-h` on the verdict line that the loaded state carries.
 *
 * `h-4` on the rows is the one thing that is NOT mirrored, and has to be stated: a real row takes
 * its height from its `text-xs` line box (16px), where the tallest thing in a skeleton row is a
 * 14px glyph. Without it this box shrank 6px as the probe landed — small, but shrinking is the one
 * thing this component exists to prevent.
 */
function EngineCheckSkeleton() {
  return (
    <div aria-busy="true" aria-label="Reading the controller">
      <ul className="space-y-1 text-xs">
        {[0, 1, 2].map((i) => (
          <li key={i} className="flex h-4 items-center gap-2">
            <span className="h-3.5 w-3.5 shrink-0 animate-pulse rounded-full bg-gray-700" />
            <span className="w-32 shrink-0">
              <span className="block h-3 w-20 animate-pulse rounded bg-gray-700/70" />
            </span>
            <span className="block h-3 w-24 animate-pulse rounded bg-gray-700/70" />
          </li>
        ))}
      </ul>
      <p className="mt-2 flex min-h-[2rem] items-start gap-1.5 text-xs">
        <span className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-pulse rounded-full bg-gray-700" />
        <span className="block h-3 w-48 animate-pulse rounded bg-gray-700/70" />
      </p>
    </div>
  );
}
