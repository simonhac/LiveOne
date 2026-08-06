# usher — architecture

> **Status:** current. Companion to the [package README](../README.md); operational triage lives in
> [operations.md](operations.md).

This document holds the invariants that no single file owns. Module headers in `core/` carry the
_why_ for their own code and are the better read for any one mechanism — what follows is the model
those files share, and the decisions that a future change could plausibly and silently break.

## The Source contract is deliberately tiny

A source (`core/source.ts`) is a **manifest** — metadata for the points it produces — plus a
`read()` that returns named values. That is the whole required surface. Optional additions:
`isRunning()` (drives the faster cadence), `reset()` (drop a cached connection), `snapshot()`
(source-specific detail for the inspector).

Everything else is shared in `core/`: assembling self-describing readings from the manifest
(`build.ts`), stamping time and session label, POSTing with retry/backoff (`pusher.ts`), scheduling
(`run.ts`), journalling and spooling (`blackbox.ts`, `spool.ts`).

That split is the package's main design decision, and it makes adding a device small:

1. write a `Source` in `sources/`;
2. add a variant to the discriminated union in `core/config.ts` (zod — this is also the docs for the
   YAML);
3. add one arm to the `switch` in `core/factory.ts`, plus its cadence.

If a change would require a source to know about pushing, spooling or scheduling, it is in the wrong
place.

## Deploy-target independence

The usher runs on a Fly hub (devices reached over WireGuard) or on a Raspberry Pi on the site LAN,
from the same build. This is not a happy accident to be preserved by luck — it holds because the
application code contains **no** target-specific logic: no Fly APIs, no `FLY_*` reads, no tunnel
handling. A source connects to a `host:port` and does not care why that address routes.

Keep it that way. Anything target-specific belongs in `deploy/` (the Fly `entrypoint.sh` brings up
WireGuard; the Pi uses a systemd unit), never in `core/` or `sources/`.

## Poll ≠ push

`intervalMs` on a `ScheduledEntry` is the **push** period, not the device poll period. A source may
poll far faster internally: the Fronius `Site` self-polls every 2 s to integrate energy, and the run
loop harvests its minutely report. Conflating the two would either flood gusher or destroy the
integrator's resolution.

Each entry runs its own independent loop, so sources with different cadences coexist in one process.

## Boundary alignment decides when we wake, never what time we report

With `alignToBoundary` (the default), `msUntilNextBoundary()` schedules ticks on wall-clock multiples
of the period — every 5 minutes on `:00`/`:05`. That governs **only the wake-up**. Every reading is
stamped with its actual read time and is never snapped back to the boundary.

This matters because snapping would look tidier in a chart and would be wrong: it would claim
measurement precision the device never gave us, and it would collide with the receiver's
`(systemId, pointId, measurementTime)` idempotency key.

## Active cadence

If a source implements `isRunning()` and returns true for the values just read, the loop switches to
`activeIntervalMs` until it reports idle again. musher uses this to go from a 5-minute idle cadence
to 1 minute while the generator is running — fine resolution exactly when something is happening,
and cheap the rest of the time.

## The durability model

This is the part most worth understanding, and the two mechanisms are routinely conflated:

- The **blackbox** is a _flight recorder_. It holds everything that was **collected**, whether or not
  it was ever delivered. It is history.
- The **spool** is an _outage buffer_. It holds only what has **not been delivered yet**, and is
  normally empty. It is a work queue.

Recovering from an outage uses the spool. Answering "what did the device actually report at 03:14?"
uses the blackbox. They are not two views of the same data, and neither substitutes for the other.

Both exist because of a real incident: in July 2026 a database outage lost ~35 minutes of push-fed
data, because the collector held each batch in memory for exactly one tick.

### The chain, in order

`core/run.ts` → `tickOnce()`:

1. **Journal before pushing.** The blackbox records what was _collected_, not what was _delivered_,
   so a batch survives even a permanent rejection downstream.
2. **The push returns one of three outcomes** (`core/pusher.ts`) — this is the decision everything
   after it hangs on:
   - `ok` — acked; the receiver durably persisted the batch.
   - `transient` — network error, 5xx or 429, still failing after 3 retries with capped exponential
     backoff (15 s per-attempt timeout). Worth re-sending later → spool.
   - `rejected` — a permanent 4xx: bad key, bad site, bad body. Retrying cannot help, so the batch is
     dropped from the delivery path — and the blackbox is the record of what was dropped.
3. **Spool on `transient` only.** Never on a 4xx; a rejected batch would be rejected forever and
   would fill the buffer.
4. **Drain on the next successful ack**, not on a timer. The ack _is_ the evidence the receiver
   recovered, so `runEntryLoop` drains only when `result.pushOk`.
5. **Re-sends are safe only because the receiver is idempotent** on
   `(systemId, pointId, measurementTime)`. This is a load-bearing precondition, not an
   implementation detail of the far side: if gusher ever stopped deduplicating, every spool drain
   would double-count.

### Blackbox mechanics (`core/blackbox.ts`)

Daily append-only JSONL, `<dir>/YYYY-MM-DD.jsonl` on the UTC day. One line per collected batch:
`at`, `siteId`, `sessionLabel`, `measurementTime`, `count`, `readings[]`.

- Completed days are gzipped (~15×) at the day roll **and at startup**, so a process that died
  mid-day still gets its previous days compressed.
- Appends are serialized through a promise chain, so a day-roll can never interleave with a write.
- GC deletes the **oldest archives** while the filesystem is below 10% free
  (`BLACKBOX_MIN_FREE_FRAC`), with low-disk warnings as free space crosses 25% and 15%.

GC may prune freely precisely _because_ the archive is history and not the buffer. Do not repurpose
it as one.

### Spool mechanics (`core/spool.ts`)

One file per batch — `<spooledAtMs>-<seq>-<siteId>.json`, written atomically, deleted the moment a
re-send is acked. So a healthy spool directory is empty.

- **Drain** is per-site, oldest-first, capped at `SPOOL_DRAIN_BUDGET` (50) batches per call, so a
  large backlog flushes over several ticks instead of stalling the collector's cadence.
- A `transient` re-send **breaks** the drain immediately — the receiver is still down, so there is
  nothing to gain from grinding through the rest.
- A 4xx during a drain deletes the file with a loud log (it is still in the blackbox).
- A per-site re-entrancy guard stops overlapping ticks double-sending.
- **Never-fill guard:** before each write, the spool drops its _oldest_ unsent batches until it fits
  under `SPOOL_MAX_DISK_FRAC` (75%) of filesystem capacity — loudly, and noting they remain in the
  journal.

### Failure posture: degrade the store, never the collector

Both stores are constructed with a write probe and return `null` — disabled, logged — rather than
throwing if their directory is unwritable. The usher then runs on without them; readings survive only
within a single push attempt, which is the pre-July-2026 behaviour.

A blackbox write failure disables journaling once, with one warning rather than a log flood. The
5-minute `maintain()` pass re-probes and re-enables when the disk recovers, and maintenance itself
never throws into the loop.

### Neither store ever writes the apiKey to disk

It is re-attached from the environment at send time. Worth stating explicitly, because a spool file
is otherwise a complete, replayable gush request body.

### Where it lives

`blackbox/` and `spool/` sit under the store root, resolved as `usher.yaml` `dataDir` →
`$USHER_DATA_DIR` → `./.usher-data`. On the Fly hub that is the mounted volume at `/data/usher`; on a
Pi it is any writable directory.

Sizing: roughly 1 MB/day of compressed journal, so a 1 GB volume holds years. The spool may grow to
75% of the disk during an outage — weeks of buffer. Both surface in the inspector through `StoreView`
(`state/view.ts`): store path, disk free fraction, and each store's cached stats.

### Why the tick timeout covers the read but not the push

`tickOnce` applies its hard timeout to the device **read** only. The push is separately bounded by
the Pusher's own per-attempt fetch timeout and capped retries.

That asymmetry is deliberate and load-bearing. If the tick timeout spanned the push, a slow receiver
could abort the tick in the window between "journalled" and "spooled" — the one window in which an
outage silently drops a batch. A future refactor that tidies the timeout to wrap the whole tick would
reintroduce exactly the data-loss bug the spool exists to prevent.

The read needs the timeout for a concrete reason: a Modbus read on a silently-dead socket can hang
forever, because the client library's read timeout does not fire on a dead socket. On timeout the
loop also calls `source.reset()` so the next tick reconnects rather than inheriting the dead socket.

## The package boundary

The usher must not import the app's `@/lib` at runtime. The only shared surface is
[`@liveone/protocol`](../../protocol/README.md) — `PushReading` and `GushRequestBody`, type-only.

This is what lets the usher deploy independently of the LiveOne app, on a machine that has none of
the app's database or auth configuration.

## Transport: why WireGuard, not Tailscale

Recorded here because it is a decision, not a fact recoverable from the code.

The Fly hub is a multi-peer WireGuard server; each site's UniFi gateway dials in as a WireGuard
**client** (UniFi's native site-to-site does only OpenVPN/IPsec, and its own Site Magic is
UniFi-to-UniFi, so neither reaches a Fly container).

Tailscale would work on the Fly side and handles CGNAT better, but there is no first-party Tailscale
on UniFi. The only route is the community `SierraSoftworks/tailscale-unifi` package: a root install
over SSH, with persistence across firmware upgrades depending on a `/data/on_boot.d` boot hook. And
reaching devices _behind_ the gateway needs the gateway to act as a **subnet router**, which requires
TUN mode rather than userspace networking — only the reliable default on UDM since January 2025.

The deciding factor is the failure mode, not the feature list: the sites are behind CGNAT with no
inbound path, so the gateway is the only way back in. UniFi's WireGuard VPN Client is a shipped UI
feature that a firmware update cannot break; unsupported root software on that same box can strand a
site. If Ubiquiti ships native Tailscale, this is worth revisiting.
