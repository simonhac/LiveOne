/**
 * A gallery-scoped `fetch` stub for the control-plane routes, so the control DIALOGS can be driven
 * without hardware, without auth and without a database.
 *
 * ## Why this exists at all
 *
 * The generator dialog is the least reviewable surface in the app. It cannot be seen on
 * `liveone-dev`: no dashboard doc there carries the generator tile, and the two text points the tile
 * keys off (`source.generator.control.status/state`, `source.generator.mode/state`) have a NULL
 * `value_str` in the mirror, so they never reach KV and the tile's `isAvailable` refuses to mount
 * it. A Vercel preview reads the same database, so it has the identical gap. That left production
 * as the only place to look at a dialog whose whole job is to decide whether to start a diesel
 * engine — which is exactly backwards.
 *
 * ## Why patching `fetch` is acceptable HERE
 *
 * It is scoped three ways: installed only while a gallery section is mounted, restored on unmount,
 * and only ever consulted for `/api/v4/points/…` paths — anything else is delegated to the real
 * `fetch` untouched. The page itself is `notFound()` in production (`page.tsx`) and allow-listed as
 * public only for non-prod (`lib/route-matchers.ts`), so this module cannot load in a deployed
 * production build.
 *
 * ## What it deliberately does NOT do
 *
 * It does not reimplement `gateStart()`, or decide anything. Each scenario is a canned hub answer,
 * transcribed from the shapes `lib/vendors/deepsea/control.ts` actually returns. A stub that made
 * its own safety judgements would be a second opinion about starting an engine, which is the one
 * thing the real dialog is written never to have.
 */

import type { StructuredMessage } from "@/lib/control/message-format";

interface PreflightBody {
  ok: boolean;
  wouldProceed?: boolean;
  verdict: string;
  verdictMessage?: StructuredMessage;
  checks?: { label: string; value: string; ok: boolean | null }[];
  detail?: {
    maxRuntimeSec?: number;
    latched?: boolean;
    stopAt?: string | null;
    state?: string;
    panelMode?: string | null;
  } | null;
}

/** The three checks the DeepSea probe always returns, in order, all passing. */
const HAPPY_CHECKS = [
  { label: "Panel mode", value: "Auto", ok: true },
  { label: "Engine", value: "stopped", ok: true },
  { label: "Inverter demand", value: "not calling", ok: true },
];

/** 6 h — the hub's cap, so the slider offers every preset. */
const MAX_RUNTIME_SEC = 21_600;

/** The house 12-hour spelling, as the run-periods route would have produced it server-side. */
function formatClock(d: Date): string {
  const h = d.getHours();
  const hour = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${hour}:${String(d.getMinutes()).padStart(2, "0")}${h >= 12 ? "pm" : "am"}`;
}

/** An instant `minutesAhead` from now, ISO — what the hub puts in `stopAt`. */
const stopAtIso = (minutesAhead: number): string =>
  new Date(Date.now() + minutesAhead * 60_000).toISOString();

export type ControlScenarioName =
  | "ready to start"
  | "checking (skeleton)"
  | "refused: panel not in Auto"
  | "refused: engine already running"
  | "already latched (ISO instant)"
  | "hub unreachable"
  | "no control passkey";

/**
 * The canned preflight per scenario.
 *
 * "already latched" is the one that motivated the ICU work: the hub's sentence names a deadline, and
 * before the change it reached the reader as `stop at 2026-08-29T14:03:38.346Z`. Both forms are sent
 * here — the flat `verdict` with its ISO (what an older hub sends) and the `verdictMessage`
 * template — so the gallery shows that the dialog prefers the template and that the fallback still
 * localizes the flat one.
 */
export function preflightFor(scenario: ControlScenarioName): PreflightBody {
  switch (scenario) {
    case "ready to start":
      return {
        ok: true,
        wouldProceed: true,
        verdict: "a 60s run would START now",
        checks: HAPPY_CHECKS,
        detail: {
          maxRuntimeSec: MAX_RUNTIME_SEC,
          latched: false,
          stopAt: null,
          // `state` + `panelMode` are what let the dialog re-derive its header sentence from the
          // PROBE rather than from the pushed point — so the gallery exercises that path too.
          state: "idle",
          panelMode: "Auto",
        },
      };

    case "refused: panel not in Auto":
      return {
        ok: true,
        wouldProceed: false,
        verdict:
          "a run would be REFUSED: module is not in Auto (mode=Stop) — possible local lockout; not overridable remotely",
        checks: [
          { label: "Panel mode", value: "Stop", ok: false },
          ...HAPPY_CHECKS.slice(1),
        ],
        detail: {
          maxRuntimeSec: MAX_RUNTIME_SEC,
          latched: false,
          stopAt: null,
          // Idle + a panel out of Auto is LOCKED OUT, not armed — the probe carries both facts, so
          // the header says so without waiting for the pushed mode point.
          state: "idle",
          panelMode: "Stop",
        },
      };

    case "refused: engine already running":
      return {
        ok: true,
        wouldProceed: false,
        verdict:
          "a run would be REFUSED: engine is already running, commanded by the remote start input",
        checks: [
          HAPPY_CHECKS[0],
          { label: "Engine", value: "running", ok: false },
          {
            label: "Inverter demand",
            value: "calling for the generator",
            ok: null,
          },
        ],
        detail: {
          maxRuntimeSec: MAX_RUNTIME_SEC,
          latched: false,
          stopAt: null,
          state: "running:sp-pro",
          panelMode: "Auto",
        },
      };

    case "already latched (ISO instant)": {
      const stopAt = stopAtIso(23);
      return {
        ok: true,
        wouldProceed: false,
        // The flat leg keeps the ISO on purpose — this is what an older hub sends.
        verdict: `a run is already latched (stop at ${stopAt}); a request would EXTEND it`,
        verdictMessage: {
          template:
            "a run is already latched (stop at {stopAt, time, short}); a request would EXTEND it",
          values: { stopAt },
        },
        checks: HAPPY_CHECKS,
        detail: {
          maxRuntimeSec: MAX_RUNTIME_SEC,
          latched: true,
          stopAt,
          state: "running:hub",
          panelMode: "Auto",
        },
      };
    }

    case "hub unreachable":
      return {
        ok: false,
        verdict:
          "device unreachable: connect ETIMEDOUT 10.0.1.244:502 — the hub could not read the controller, so a real run would refuse too",
      };

    case "no control passkey":
      return {
        ok: false,
        verdict:
          "This generator has no control passkey stored — generator control is not set up for this device",
      };

    case "checking (skeleton)":
    default:
      return preflightFor("ready to start");
  }
}

/** A canned command log, newest first — enough rows that "Show more" has something behind it. */
function commandRows(count: number, offset: number) {
  const now = Date.now();
  const verbs = [
    { action: "set_value", value: 30, status: "ok" },
    { action: "set_value", value: 0, status: "ok" },
    { action: "set_value", value: 60, status: "ok" },
    { action: "set_value", value: 5, status: "rejected" },
  ];
  return Array.from({ length: count }, (_, i) => {
    const n = offset + i;
    const v = verbs[n % verbs.length];
    return {
      pointId: "pt_01kybrhzkmfyxvz63d15rscj19",
      logicalPath: "source.generator.control.request",
      metricType: "duration",
      action: v.action,
      value: v.value,
      status: v.status,
      reason: v.status === "rejected" ? "not_in_auto" : null,
      error: null,
      requestedBy: { kind: "user" as const },
      // Spread back through the evening so the "yesterday"/date prefixes are exercised too.
      requestedAt: new Date(now - n * 37 * 60_000).toISOString(),
      completedAt: new Date(now - n * 37 * 60_000 + 1_200).toISOString(),
    };
  });
}

/** How many rows the fake trail holds in total — 137 so paging lands mid-page at the end. */
const TOTAL_COMMANDS = 137;

/**
 * Install the stub. Returns the uninstaller; call it on unmount.
 *
 * `delayMs` is how long the preflight takes to answer, which is the whole point of the
 * "checking (skeleton)" scenario: a probe over WireGuard to a Modbus device is not instant, and the
 * loading state is a state a reviewer needs to be able to sit and look at.
 */
export function installControlStub(opts: {
  scenario: () => ControlScenarioName;
  delayMs?: () => number;
  /** Is a run open? Drives whether the tile's row reads "Since h:mma" or "This period". */
  runOpen?: () => boolean;
}): () => void {
  const real = globalThis.fetch;

  const stub: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    const handled =
      url.includes("/api/v4/points/") ||
      url.includes("/run-periods") ||
      url.includes("/api/data");
    if (!handled) return real(input, init);

    const wait = (ms: number) =>
      new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    if (url.includes("/preflight")) {
      const scenario = opts.scenario();
      await wait(
        opts.delayMs?.() ?? (scenario === "checking (skeleton)" ? 60_000 : 400),
      );
      return json(preflightFor(scenario));
    }

    if (url.includes("/action")) {
      await wait(700);
      const stopAt = stopAtIso(30);
      return json({
        ok: true,
        reason: `Generator starting — runs until ${stopAt}.`,
        reasonMessage: {
          template: "Generator starting — runs until {stopAt, time, short}.",
          values: { stopAt },
        },
      });
    }

    if (url.includes("/commands")) {
      const q = new URL(url, "http://localhost");
      const limit = Number(q.searchParams.get("limit") ?? "5");
      const offset = Number(q.searchParams.get("offset") ?? "0");
      await wait(250);
      const remaining = Math.max(0, TOTAL_COMMANDS - offset);
      return json({
        commands: commandRows(Math.min(limit, remaining), offset),
        hasMore: offset + limit < TOTAL_COMMANDS,
        offset,
        limit,
      });
    }

    // The two reads a tile fires once it has a `systemId`. Without them the generator tile's
    // "Generated" row has nothing to show and vanishes — which is exactly the row a reviewer is
    // here to look at, so the gallery answers them rather than letting them 404.
    if (url.includes("/run-periods")) {
      await wait(200);
      const startedMinsAgo = 77;
      const startTimeISO = new Date(
        Date.now() - startedMinsAgo * 60_000,
      ).toISOString();
      const running = opts.runOpen?.() ?? true;
      return json({
        role: "generator",
        running,
        // Period totals — what the row shows when NO run is open.
        totalEnergyKwh: 12.463,
        totalDurationSeconds: 15_600,
        totalCostC: 986,
        costKnownKwh: 12.463,
        events: running
          ? [
              {
                running: true,
                startTimeISO,
                // `startTime` is what the tile renders: already spelled by the server in the
                // DEVICE's display timezone, which is why the tile never formats it itself.
                startTime: formatClock(new Date(startTimeISO)),
                date: "Sat 29 Aug",
                endTimeISO: null,
                durationSeconds: null,
                energyKwh: 4.212,
                costC: 333,
                estimatedKwh: 0,
              },
            ]
          : [],
      });
    }

    if (url.includes("/api/data")) {
      await wait(150);
      return json({ latest: {}, canControl: true, canControlDevices: [14] });
    }

    return real(input, init);
  };

  globalThis.fetch = stub;
  return () => {
    globalThis.fetch = real;
  };
}
