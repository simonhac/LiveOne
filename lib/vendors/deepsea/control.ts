/**
 * DeepSea's `ControlCapability` — the one place a point action becomes a generator run request.
 *
 * Mirrors `lib/vendors/tesla/control.ts` deliberately: resolve (logical address, action) to a
 * dispatch, call the vendor path, return benign declines rather than throwing them. The vendor
 * "path" here is the usher hub (see ./hub-client.ts), which owns the run deadline.
 *
 * 🛑 THE UNIT SEAM LIVES HERE, AND ONLY HERE. The point is in MINUTES (what a human sets and
 * reads back); the hub speaks SECONDS. One multiply, in one function, with a test — because a
 * silent factor-of-60 on a command that runs a diesel engine is the kind of bug that reads as
 * "it stopped after 30 seconds" or, far worse, "it ran for 30 hours".
 *
 * 🛑 The passkey is ALWAYS the DEVICE OWNER's, resolved from their Clerk credentials — never a
 * session user's and never an env var. Same rule as Tesla (lib/control/ownership.ts): an admin
 * commanding someone else's hardware does so on the owner's credentials, an automation with no
 * session user resolves them from the device alone, and an OWNERLESS device is commandable by
 * nobody. An env var would make the credential a property of the deployment instead, so any device
 * on it could command the generator.
 *
 * 🛑 Two independent ceilings guard the runtime, and that is on purpose: the point's `control`
 * descriptor (max minutes, enforced by `validatePointAction` before we are called) and the hub's
 * `control.maxRuntimeSec` (enforced on the hub, which is the thing actually holding the latch).
 * They are NOT derived from each other — a mistake in the web app's config cannot widen what the
 * hub will accept.
 */
import type {
  ControlCapability,
  ControlInvokeContext,
  ControlPreflightCheck,
  ControlPreflightContext,
  ControlPreflightResult,
  ControlInvokeResult,
} from "../types";
import { ControlDispatchError } from "@/lib/control/errors";
import { getDeviceCredentials } from "@/lib/secure-credentials";
import { hubProbe, hubRun, type HubProbeResult } from "./hub-client";

/**
 * The point this capability commands, by LOGICAL address (`logicalPath/metricType`) so it stays
 * stable across physical field renames — same convention as Tesla's `resolveDispatch`.
 */
export const RUN_REQUEST_ADDRESS = "source.generator.control.request/duration";

/**
 * Resolve (site, owner passkey) for a point this capability answers for — shared by `invoke` and
 * `preflight` so the two can never disagree about WHICH point is commandable or WHOSE credentials
 * command it. Throws the same `ControlDispatchError`s `invoke` always has.
 */
async function resolveTarget(ctx: {
  device: ControlInvokeContext["device"];
  point: ControlInvokeContext["point"];
}): Promise<{ siteId: string; passkey: string }> {
  const address = `${ctx.point.logicalPath ?? ""}/${ctx.point.metricType}`;
  if (address !== RUN_REQUEST_ADDRESS) {
    // A server config bug rather than a user error: `points.control` claims this point is
    // writable but this vendor has no command for it. Surfaces as 'failed'/500.
    throw new Error(
      `DeepSea has no command for ${ctx.point.logicalPath ?? "?"}/${ctx.point.metricType}`,
    );
  }

  const siteId = ctx.device.vendorSiteId;
  if (!siteId) {
    throw new ControlDispatchError("Device has no vendor site id", 400);
  }

  const ownerId = ctx.device.ownerClerkUserId;
  if (!ownerId) {
    // Not an oversight: ownerless hardware is commandable by nobody, because there are no
    // credentials to command it WITH. See lib/control/ownership.ts.
    throw new ControlDispatchError("System has no owner", 400);
  }

  const credentials = await getDeviceCredentials(ownerId, ctx.device.id);
  const passkey = credentials?.controlPasskey;
  if (typeof passkey !== "string" || !passkey) {
    throw new ControlDispatchError(
      "This generator has no control passkey stored — generator control is not set up for this device",
      501,
    );
  }
  return { siteId, passkey };
}

/**
 * The hub's read-only answer, as the generic checklist the UI renders. Deliberately a straight
 * TRANSCRIPTION of what the hub read — no facts are invented here, and `wouldProceed`/`verdict`
 * are passed through rather than recomputed, because the hub derives them from the same
 * `gateStart()` a real request consults.
 */
function probeChecks(probe: HubProbeResult): ControlPreflightCheck[] {
  // `ok:false` means the controller could not be read, so there are no facts to transcribe. The
  // hub's `verdict` says why, and it is the whole answer in that case.
  if (!probe.ok) return [];
  return [
    {
      label: "Panel mode",
      value:
        probe.modeName ?? (probe.mode == null ? "unreadable" : `${probe.mode}`),
      // Mode 1 is Auto. Anything else may be a deliberate local lockout (refuelling, hands in the
      // engine bay) and is NOT overridable remotely — see gateStart() on the hub.
      ok: probe.mode === 1,
    },
    {
      label: "Engine",
      // The controller's own word when it has one: an engine winding down after a run is a
      // different fact from one someone is commanding, and it is the difference between a reader
      // waiting a minute and a reader going to look at the shed.
      value: !probe.running
        ? "stopped"
        : probe.engineState === 4 || probe.engineState === 6
          ? "cooling down"
          : "running",
      ok: !probe.running,
    },
    {
      label: "Inverter demand",
      value:
        probe.remoteStartInput === "closed"
          ? "calling for the generator"
          : probe.remoteStartInput === "open"
            ? "not calling"
            : "unknown",
      // Informational, not a gate: the SP-PRO calling is only a refusal in combination with the
      // engine already running, which the row above already reports.
      ok: probe.remoteStartInput === "closed" ? null : true,
    },
    // 🛑 The module's SCF support is deliberately NOT a row. On every module in service it reads
    // "start / cancel" forever — a constant, which is the one thing a checklist should not spend a
    // line on — and when it is NOT true the hub says so far more usefully than a row could: the
    // probe appends "the module does not advertise Cancel Telemetry Start (fn 33), so a run could
    // not be stopped" to the verdict and clears `wouldStart`, which disables Start and prints the
    // sentence. The fact survives; only the noise is gone.
  ];
}

export class DeepSeaControlCapability implements ControlCapability {
  async invoke(ctx: ControlInvokeContext): Promise<ControlInvokeResult> {
    if (ctx.action !== "set_value") {
      // A server config bug rather than a user error: `points.control` claims this point is
      // writable but this vendor has no command for it. Surfaces as 'failed'/500.
      throw new Error(
        `DeepSea has no command for ${ctx.point.logicalPath ?? "?"}/${ctx.point.metricType} action '${ctx.action}'`,
      );
    }

    const minutes = ctx.value;
    if (
      typeof minutes !== "number" ||
      !Number.isFinite(minutes) ||
      minutes < 0
    ) {
      throw new ControlDispatchError(
        "A run request needs a non-negative number of minutes (0 stops)",
        400,
      );
    }

    const { siteId, passkey } = await resolveTarget(ctx);

    const runtimeSec = Math.round(minutes * 60); // ← the unit seam
    const result = await hubRun(siteId, passkey, runtimeSec);

    if (!result.ok) {
      // The hub refused (not in Auto, already running under someone else's command, over its own
      // cap, an ambiguous write). These are RETURNED as benign declines with the hub's own wording
      // — it knows why, and its reasons are written to be read by a human.
      return {
        ok: false,
        reason: result.reason ?? "the generator hub declined the request",
        // The hub's own template when it sent one (the ambiguous-start sentence names a deadline).
        reasonMessage: result.reasonMessage,
      };
    }

    if (runtimeSec === 0) {
      // 🛑 Released ≠ stopped. Clearing our telemetry latch cannot cancel a run the SP-PRO is
      // commanding on its own digital input, and saying "stopped" when the engine is still turning
      // would be a lie the user acts on.
      if (!result.stillRunning) {
        return {
          ok: true,
          reason:
            "Run request released; the generator will cool down and stop.",
        };
      }
      // 🛑 Three outcomes, not two. "Still running" used to collapse the ORDINARY one — our own
      // cool-down, which is what a stop looks like for the next minute or two — into the alarming
      // sentence written for a run we cannot end, so every successful stop read like a failure.
      // The hub now distinguishes them (see RunSupervisor.release); this only spells them.
      if (result.stillRunning === "cool-down") {
        return {
          ok: true,
          reason:
            "Run request released; the engine is cooling down and will stop shortly.",
        };
      }
      return {
        ok: true,
        reason: `Released the hub's run request, but the engine is still running — it is being commanded by ${result.stillRunning === "remote-start-input" ? "the SP-PRO inverter" : "an unknown source"}, which this control cannot override.`,
      };
    }

    // 🛑 The AUDIT sentence keeps the instant in ISO, and the DISPLAY sentence is a template the
    // reader spells. This used to render `Australia/Melbourne` in a hardcoded `en-AU` call, which
    // was wrong twice over: it named the wrong clock for any site that is not Daylesford, and it
    // baked a presentation decision into a row that outlives the dialog that showed it.
    const extended = result.action === "extended";
    const audit = result.stopAt ?? "an unknown time";
    return {
      ok: true,
      reason: extended
        ? `Run extended — now stops at ${audit}.`
        : `Generator starting — runs until ${audit}.`,
      reasonMessage: result.stopAt
        ? {
            template: extended
              ? "Run extended — now stops at {stopAt, time, short}."
              : "Generator starting — runs until {stopAt, time, short}.",
            values: { stopAt: result.stopAt },
          }
        : undefined,
    };
  }

  /**
   * The read-only dry run, backed by the hub's `probe`: Access → passkey → registry → supervisor →
   * device mutex → Modbus over WireGuard → the DSE, using FC3 READS ONLY. There is no code path
   * from here to a control-key write, and the verdict comes from the same `gateStart()` the real
   * request path uses — which is the only reason a UI may use it as a gate.
   *
   * 🛑 A preflight NEVER throws for a bad answer. "The hub is unreachable" and "the panel is in
   * Stop" are both things the user asked to be told; turning either into a 500 would hide the one
   * fact they opened the dialog for. Only a resolution failure (wrong point, no owner, no passkey)
   * propagates, because that is a configuration bug rather than a state report.
   *
   * 🛑 `ctx.value` is IGNORED, and that is not an oversight. A probe asks about the moment: the only
   * length-sensitive term in a start decision is the hub's cap, and the cap comes back in the answer
   * (`maxRuntimeSec`) for the caller to size its own offer against. Proposing a length and asking
   * whether it fits would put a number in the hub's verdict that nobody asked about — and a verdict
   * this app renders verbatim has no room for one. The generic seam keeps `value` for a vendor whose
   * answer genuinely depends on the command.
   */
  async preflight(
    ctx: ControlPreflightContext,
  ): Promise<ControlPreflightResult> {
    const { siteId, passkey } = await resolveTarget(ctx);

    let probe: HubProbeResult;
    try {
      probe = await hubProbe(siteId, passkey);
    } catch (e) {
      // Includes the hub's own "The hub could not read the controller: … — a run would be refused
      // too." sentence, which `call()` preserves out of the 503 body's `verdict`.
      return {
        ok: false,
        verdict:
          e instanceof Error
            ? e.message
            : "The generator hub could not be reached.",
      };
    }

    const { ok, wouldStart, verdict, verdictMessage, ...state } = probe;
    return {
      ok,
      wouldProceed: wouldStart,
      // 🛑 Passed through, never rewritten — acceptance and refusal alike. The hub decided; it also
      // said why, in words meant for a reader. `verdictMessage` rides along for the one sentence
      // that names an instant, which only the browser can spell in the reader's own clock.
      verdict,
      verdictMessage,
      checks: probeChecks(probe),
      // Everything the probe read, flat: the controller as of a live FC3 read, plus the hub's own
      // bookkeeping. `state` here is `RunSupervisor.state()` — the SAME call that produces the
      // pushed `source.generator.control.status/state` point, which is what lets a caller re-derive
      // the whole status sentence from this live read rather than from a push that may be a poll
      // behind. `modeName` is the panel mode that reading takes to tell an ARMED idle generator
      // from a LOCKED OUT one.
      detail: state,
    };
  }
}
