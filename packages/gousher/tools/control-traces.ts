/** Shared control oracle: execute the production TypeScript supervisor with a simulator. */
import { RunSupervisor } from "../../usher/core/control";
import type { ControlOwnership, SourceControl } from "../../usher/core/source";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Step = {
  op: "request" | "probe" | "observe" | "reconcile" | "restart";
  advanceMs?: number;
  runtimeSec?: number;
  override?: boolean;
  ownership?: Partial<ControlOwnership>;
  failRead?: boolean;
  failStart?: boolean;
  failStop?: boolean;
  scf?: {
    selectAuto: boolean;
    telemetryStart: boolean;
    telemetryCancel: boolean;
  };
};
type Scenario = { name: string; initialState?: string; steps: Step[] };
const scenarios: Scenario[] = [
  {
    name: "start-extend-release",
    steps: [
      { op: "probe" },
      { op: "request", runtimeSec: 60.4 },
      { op: "observe", advanceMs: 1000, ownership: { running: true } },
      { op: "probe" },
      { op: "request", advanceMs: 1000, runtimeSec: 120 },
      { op: "request", advanceMs: 1000, runtimeSec: 0 },
      { op: "probe" },
      { op: "observe", ownership: { running: false } },
      { op: "probe" },
    ],
  },
  ...[0, 2, null].map(
    (mode) =>
      ({
        name: `panel-lockout-${mode}`,
        steps: [
          {
            op: "probe",
            ownership: {
              mode,
              modeName: mode === 0 ? "Stop" : mode === 2 ? "Manual" : null,
            },
          },
          { op: "request", runtimeSec: 60, override: true },
        ],
      }) as Scenario,
  ),
  ...["closed", "open", "unknown"].map(
    (remoteStartInput) =>
      ({
        name: `external-${remoteStartInput}`,
        steps: [
          { op: "observe", ownership: { running: true, remoteStartInput } },
          { op: "probe" },
          { op: "request", runtimeSec: 60 },
          { op: "request", runtimeSec: 60, override: true },
          { op: "request", runtimeSec: 0 },
        ],
      }) as Scenario,
  ),
  ...[4, 6].map(
    (engineState) =>
      ({
        name: `cooldown-${engineState}`,
        steps: [
          {
            op: "probe",
            ownership: {
              running: true,
              engineState,
              engineStateName: engineState === 4 ? "Cooling down" : "Post-run",
            },
          },
          { op: "request", runtimeSec: 60 },
        ],
      }) as Scenario,
  ),
  {
    name: "missing-scf",
    steps: [
      {
        op: "probe",
        scf: {
          selectAuto: false,
          telemetryStart: false,
          telemetryCancel: false,
        },
      },
    ],
  },
  {
    name: "unreadable",
    steps: [
      { op: "probe", failRead: true },
      { op: "request", runtimeSec: 60 },
    ],
  },
  {
    name: "ambiguous-start",
    steps: [
      { op: "request", runtimeSec: 60, failStart: true },
      { op: "request", runtimeSec: 120, advanceMs: 1000 },
      { op: "reconcile", advanceMs: 120000 },
    ],
  },
  {
    name: "failed-stop",
    steps: [
      { op: "request", runtimeSec: 60 },
      { op: "request", runtimeSec: 0, failStop: true },
      { op: "request", runtimeSec: 120 },
      { op: "reconcile", advanceMs: 120000, failStop: false },
    ],
  },
  {
    name: "deadline",
    steps: [
      { op: "request", runtimeSec: 60 },
      { op: "reconcile", advanceMs: 59999 },
      { op: "reconcile", advanceMs: 1 },
    ],
  },
  {
    name: "invalid-runtime",
    steps: [
      { op: "request", runtimeSec: -1 },
      { op: "request", runtimeSec: 601 },
    ],
  },
  {
    name: "restart-future",
    steps: [
      { op: "request", runtimeSec: 60 },
      { op: "restart", advanceMs: 10000 },
      { op: "reconcile", advanceMs: 50000 },
    ],
  },
  {
    name: "restart-overdue",
    steps: [
      { op: "request", runtimeSec: 60 },
      { op: "restart", advanceMs: 61000 },
    ],
  },
  ...[undefined, "not json", '{"latched":true,"stopAt":"bad"}'].map(
    (initialState, i) =>
      ({
        name: `defensive-boot-${i}`,
        initialState,
        steps: [{ op: "restart" }],
      }) as Scenario,
  ),
  {
    name: "defensive-panel-stop",
    steps: [{ op: "restart", ownership: { mode: 0, modeName: "Stop" } }],
  },
  {
    name: "clean-boot",
    initialState: '{"latched":false,"stopAt":null}',
    steps: [{ op: "restart" }],
  },
];

export async function buildControlTraces() {
  const traces = [];
  for (const scenario of scenarios) {
    const dir = await mkdtemp(join(tmpdir(), "control-oracle-"));
    let wall = Date.parse("2026-09-12T00:00:00.000Z"),
      mono = 0n,
      starts = 0,
      stops = 0;
    let failRead = false,
      failStart = false,
      failStop = false;
    let ownership: ControlOwnership = {
      mode: 1,
      modeName: "Auto",
      running: false,
      remoteStartInput: "open",
      engineState: null,
      engineStateName: null,
    };
    let scf = { selectAuto: true, telemetryStart: true, telemetryCancel: true };
    const target: SourceControl = {
      async start() {
        starts++;
        if (failStart) throw new Error("write timeout");
      },
      async stop() {
        stops++;
        if (failStop) throw new Error("write timeout");
      },
      async readOwnership() {
        if (failRead) throw new Error("read timeout");
        return { ...ownership };
      },
      async preflight() {
        return {
          ownership: await target.readOwnership(),
          scfSupported: { ...scf },
          scfMap: [16384, 0, 49152, 0, 0, 0, 0, 0],
        };
      },
    };
    const make = () =>
      new RunSupervisor({
        siteId: "site",
        target,
        config: { passkeyEnv: "TEST", maxRuntimeSec: 600 },
        dataDir: dir,
        clock: { now: () => wall, mono: () => mono },
      });
    let sup = make();
    try {
      if (scenario.initialState !== undefined) {
        await mkdir(join(dir, "control"), { recursive: true });
        await writeFile(join(dir, "control/site.json"), scenario.initialState);
      }
      const steps = [];
      for (const step of scenario.steps) {
        wall += step.advanceMs ?? 0;
        mono += BigInt(step.advanceMs ?? 0) * 1000000n;
        ownership = { ...ownership, ...step.ownership };
        scf = step.scf ?? scf;
        failRead = step.failRead ?? failRead;
        failStart = step.failStart ?? failStart;
        failStop = step.failStop ?? failStop;
        let result: unknown = null;
        switch (step.op) {
          case "request":
            result = await sup.request(step.runtimeSec!, {
              overrideRemoteStart: step.override,
            });
            break;
          case "probe":
            result = await sup.probe();
            break;
          case "observe":
            sup.noteObservation(ownership);
            break;
          case "reconcile":
            await sup.reconcile();
            break;
          case "restart":
            sup.dispose();
            sup = make();
            await sup.resume();
            break;
        }
        steps.push({
          ...step,
          expected: {
            result,
            status: sup.status(),
            values: sup.syntheticValues(),
            transition: sup.inTransition(),
            starts,
            stops,
          },
        });
      }
      traces.push({ ...scenario, steps });
    } finally {
      sup.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  }
  return JSON.parse(JSON.stringify(traces));
}
if (require.main === module)
  buildControlTraces().then(async (traces) => {
    await writeFile(
      resolve(__dirname, "../internal/gousher/testdata/control-traces.json"),
      JSON.stringify(traces, null, 2) + "\n",
    );
  });
