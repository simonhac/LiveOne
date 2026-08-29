# DSE inhibit command — design + on-site test protocol

**Status: designed, deliberately unimplemented.** The `run` command (hub-supervised start/stop,
PR that added `packages/usher/core/control.ts`) shipped first; `inhibit` is deferred to a session
when someone is **on site with eyes on the physical panel**, because its failure mode is the
inverse of `run`'s and worse: a stuck inhibit leaves the off-grid house with **no auto-start at
all**. This doc is the complete handoff — design, state table, sharp edges, and the test protocol.

## What inhibit is for

Occasionally we want to stop (or hold off) a generator run **the SP-PRO commanded** via digital
input A (terminal 51). The `run` command cannot do that: its stop is Telemetry Cancel (fn 33),
which clears only *our* latch — the SP-PRO's input-A request stays asserted and the engine keeps
running. The only GenComm lever that overrides *every* start source is **Select Stop (fn 0)**,
because remote start is honoured only in Auto mode.

That makes inhibit a **persistent mode change**, not a momentary command: while the module sits in
Stop, the house cannot start its own generator. Every design decision below flows from that.

## Design (agreed 2026-08-29)

- `POST /api/usher/control/[siteId]/inhibit { passkey, inhibitSec }`; `inhibitSec: 0` releases
  immediately. Config: `control.maxInhibitSec` (schema cap 1 h, default 30 min — deliberately much
  shorter than `maxRuntimeSec`). Absent from config → 404, same fail-closed rule as `control`.
- **Sequence on inhibit**: persist intent → run the full run-stop path first (fn 33 + clear any
  hub-run state, *confirmed*) → then write fn 0. One state machine owns the device: inhibit and run
  are states of the same `RunSupervisor`, never two machines racing on one Modbus target.
- **Hold until input A opens**, capped at `maxInhibitSec`:
  - input A **open** → the SP-PRO withdrew its request → fn 1 (Auto), clear the inhibit. Clean
    exit: Auto restored with nothing asking for a start.
  - cap reached with A still **closed** → restore Auto anyway and log loudly — **the engine will
    restart within seconds**. The response/inspector must say this up front.
  - Input-A state comes from the poll's last-read 3089 with a staleness bound: if the last
    successful read is older than 2 poll periods (comms outage), fall back to **cap-only and
    restore Auto at the cap regardless** — restoring Auto blind is the safe direction off-grid.
- **Release path writes fn 33 again immediately before fn 1.** Nothing documents whether fn 0
  clears the module's internal telemetry latch; restoring Auto with a surviving latch would
  relaunch an *unsupervised* run whose `stopAt` may already be past. Treat the latch as
  latched-until-proven-otherwise. (First on-site test below settles whether fn 0 clears it.)
- **Restore-to-Auto is retried indefinitely** on failure (same 15 s loop as stop). A stuck inhibit
  is the single most dangerous state this feature can produce.
- **Persistence/restart**: `inhibitUntil` is an absolute instant (same countdown-vs-instant
  invariant as `stopAt`); on boot, resume-remaining — re-arm a future cap, restore Auto at once for
  a past one. The existing defensive-boot path (fn 33 + mode check on unreadable state) already
  flags "module in Stop with no persisted reason", which is the crash-mid-inhibit signature.
- `run` while inhibited → **409** (`run` must not write its way around an inhibit); `inhibit` while
  a hub run is latched → allowed, but runs the stop path first (above).
- New synthetic point values already reserved: `control_inhibit_active` (pushed as 0 today),
  `control_state: "inhibited"`.

## State cross-product (the table the implementation must satisfy)

| Our latch | Inhibit | Input A | Engine | Correct behaviour |
| --- | --- | --- | --- | --- |
| — | — | open | off | idle |
| — | — | closed | on | `running:sp-pro`; `run` 409s without override |
| held | — | any | on | `running:hub`; deadline enforced |
| held | requested | any | on | stop path (fn 33, confirmed) → fn 0 → `inhibited` |
| — | active | closed | off | `inhibited`; watch A every poll, cap ticking |
| — | active | open | off | release: fn 33 → fn 1 → idle |
| — | active | closed | off, cap reached | fn 33 → fn 1 → engine restarts (loud) → `running:sp-pro` |
| — | active (crash, state lost) | any | off | boot flags "module in Stop, no reason" — manual Auto at the panel may be needed |

## Sharp edges (why this waits for an on-site session)

1. **Fn 0 during a loaded run = no cool-down.** Select Stop stops promptly, unlike the graceful
   wind-down fn 33 gives. Harsher on the engine; first test should be against an *unloaded* run.
2. **Does fn 0 clear the internal telemetry latch?** Unknown. Test explicitly (protocol below).
3. **Restore-to-Auto with A closed restarts the engine.** By design under "hold until A opens",
   but it must be *observed once* before anyone trusts the cap semantics.
4. **A hub death mid-inhibit strands the module in Stop.** Bounded by the cap only if the hub comes
   back; if it never does, someone presses Auto on the panel. Keep `maxInhibitSec` small.
5. **SP-PRO's reaction to a vetoed start is unobserved.** Does it re-assert A immediately? Raise an
   alarm? Watch the SP-PRO side during the first veto.

## On-site test protocol

Someone at the panel throughout; agree an abort signal ("press Stop at the panel") first.

1. **Latch interaction** (engine off, nobody needing power): hub `run` 120 s → mid-run, write fn 0
   at the panel-adjacent laptop (or the new endpoint) → engine stops. Now fn 1 (Auto): does the
   engine restart? Yes = fn 0 did NOT clear our latch (the fn-33-before-fn-1 rule is load-bearing);
   no = fn 0 cleared it (rule stays as belt-and-braces).
2. **Unloaded inhibit**: trigger an SP-PRO start (or wait for one), confirm `running:sp-pro`, then
   `inhibit 300` → engine stops promptly (no cool-down — expected). Watch input A in the diag
   journal: does the SP-PRO hold it closed?
3. **Release-on-A-open**: force the SP-PRO to withdraw (raise its battery setpoint / satisfy the
   demand), watch the hub restore Auto and land in `idle` with the engine off.
4. **Cap expiry with A closed**: set `maxInhibitSec: 120`, inhibit while the SP-PRO still wants the
   run, let the cap expire → Auto restored → engine restarts. Confirm the response/logs said this
   would happen *before* it did.
5. **Crash drill**: mid-inhibit, `fly machine restart` — on boot the hub must resume the inhibit
   (state readable) or flag "module in Stop with no persisted reason" (state deliberately deleted
   for the drill).

## Follow-ups parked with this feature

- **`alarm_summary` promotion** (page 154 nibbles + reg 774) — monitoring work, wants the name
  table from pages 196–245 to label the 80 nibbles; do alongside inhibit or before.
- **The clean version**: a Remote Control source (page 193, regs 49408+) wired in the internal PLC
  as a start-inhibit would override input A *without leaving Auto* — an override with no dangerous
  state. Needs DSE Configuration Suite (Windows), which is its own errand
  (see `engine-senders-commissioning.md` in the site notes: web-SCADA enable, exercise scheduler,
  Modbus comms-loss shutdown all queue behind the same tool).
- Wiring `OBSERVATIONS_ALERT_WEBHOOK_URL`-style alerting into the hub for a failed restore-to-Auto
  (today it logs + retries + shows in the inspector, but nothing pages).
