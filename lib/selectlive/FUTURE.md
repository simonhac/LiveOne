# Possible directions for `selectlive`

Research snapshot: 2026-09-11. These are proposals, not implemented commands or a
commitment to build everything. Example command names below are illustrative.

The useful opportunity is a portable interface to the SP PRO itself: its retained
logs, present operating state and configuration. Select.live supplies the remote
connection; it does not turn every inverter measurement into a historical archive.

## What we have established

The CLI can authenticate through verified TLS, select an inverter, authenticate to
it, read bounded memory ranges, and preserve and decode its detailed log. A live
acquisition retrieved 5,952 records in 315 seconds from firmware 12.25, detailed
format 3. The configured interval was 15 minutes. Metadata and the newest record
remained stable during that acquisition. Independent SP LINK CSV parity is still
outstanding. See the [implementation and validation notes](../../docs/vendors/selectlive-cli.md).

The existing implementation permits only the authentication mailbox write. Reading
more fields usually means mapping addresses, versions, flags and scaling, rather
than inventing another transport. That is a promising starting point, not proof
that every SP LINK screen can be reproduced through this tunnel.

Evidence labels used below:

- **Live verified:** exercised by this CLI against the inverter.
- **Static evidence:** relevant routines or structures found in SP LINK 16.11.9663;
  the proposed feature still needs implementation and live validation.
- **Documented:** SP LINK exposes the feature; its protocol path remains to be traced.
- **Engineering proposal:** functionality we could build around the protocol or saved data.

## 1. Preserve more of the inverter's history

| Direction | What it would let us do | Evidence and remaining work |
| --- | --- | --- |
| Operational and alert events | Build a timestamped account of state changes and faults, then correlate it with power and battery readings during an outage. | **Static evidence:** `mRawDataDownload.fnDownloadEventData`, separate operational/alert collections, and `clsEventRecord`. Trace both log layouts, event codes, attached values, rejection rules and retention. Keep unknown codes and raw records. |
| Daily summaries | Retrieve the inverter's own daily accounting and compare it with detailed data and the portal. | **Static evidence:** `fnDownloadDailySummaryData` and a separate daily log descriptor. Our inverter advertises daily format 5. Decode and validate its units, date attribution, reset behavior and actual retained span; do not assume detailed-log retention applies. |
| Today and aggregate counters | Capture current-day totals and longer-term counters even when fine-grained records are gone. | **Documented:** Today, DC History and AC History views. These are aggregate readings, not a recoverable sequence of old intervals. Trace counters and their reset dates before interpreting differences. |
| Complete diagnostic acquisition | Collect identity, configuration, detailed history, events and daily records together for later analysis. | **Documented:** SP LINK's “Download All” combines these categories. Our bundle could use open formats, preserve acquisition times per component, and explicitly report partial success. It would not initially claim compatibility with SP LINK's ZIP format. |

The history categories and aggregate views are described in the
[SP LINK manual Rev 31, pp. 26–27 and 79–84](https://www.selectronic.com.au/manuals/OI0005_31%20SP%20LINK%20Manual.pdf).
The event and daily entry points were also found in the same managed assembly used
for our detailed decoder; its version and hash are recorded in the implementation notes.

Possible interfaces: `events download`, `daily download`, `totals`, and
`snapshot --include identity,configuration,detailed,events,daily`.

## 2. Inspect what the system is doing now

**Documented; address mapping and live validation required.** A typed `status`
command and bounded `watch --interval ... --duration ...` could expose:

- Power flows, voltage, frequency, battery current and state of charge.
- Charging stage, operating mode, active limits and attention flags.
- Generator availability and its start/running reasons.
- Temperatures, charging targets, midpoint readings and digital/analogue I/O state.

These fields appear in SP LINK's
[Now and Technical Data views, pp. 76–78 and 85–87](https://www.selectronic.com.au/manuals/OI0005_31%20SP%20LINK%20Manual.pdf).
For generator troubleshooting, Selectronic specifically points users at
[Data View → Now](https://selectsupport.helpdocsite.com/tech-notes2/tn0025-sp-pro-generator-controller-wiring-guide).

The interesting outputs would be explanations tied to observed flags: “which
reported condition is keeping the generator running?” or “is charging constrained
by a configured limit?” Preserve the original codes alongside their labels; do not
infer a cause solely from a low power reading.

A watcher could create a new, higher-frequency record from the time it starts.
Polling every minute would **not** recover old one-minute data or automatically
produce a one-minute average. Record acquisition times, device times when available,
sampling gaps and the acquisition span of each multi-read snapshot. A series of
register reads is not necessarily one atomic observation.

Before sustained polling, measure latency and freshness, establish a conservative
request budget, and test interaction with SP LINK and normal Select.live reporting.
Keep one request in flight per connection; the current transport explicitly rejects
concurrent reads. Do not assume additional cloud sessions are independent.

## 3. Read configuration and explain changes

**Documented, with partial static evidence.** SP LINK can retrieve configuration;
our analysis already traced the detailed-log interval to common-configuration word
54 (`0xc036`). A `config show`, `config export`, and offline `config diff` could:

- Explain how shunts and connected equipment affect the meaning of readings.
- Record the logging interval and settings relevant to generator and charging behavior.
- Show exactly which decoded settings changed between two dated snapshots.
- Preserve a baseline alongside history so later analysis has the right context.

Trace versioned configuration templates, enum values, scaling and passcode handling.
Export only understood fields by default, redact credentials and authentication
material, and retain unknown fields only in an explicitly protected raw artifact.
Compare both raw and decoded values to distinguish an actual setting change from a
decoder change. An export would initially be a record for inspection, not a tested
restore file. SP LINK's retrieval workflow is described in the
[manual, pp. 28–29](https://www.selectronic.com.au/manuals/OI0005_31%20SP%20LINK%20Manual.pdf).

## 4. Discover attached equipment and useful diagnostics

These are **documented, hardware-dependent research targets**, not capabilities
confirmed on this particular installation:

| Target | Possible use | What must be established |
| --- | --- | --- |
| Managed AC-coupled solar | Identify connected units, inspect their reported output and communication health. | Which values the SP PRO actually receives for each vendor/model; unavailable or sleeping devices must not become zero readings. |
| Managed batteries | Expose the battery information passed through to SP LINK. | Supported battery/comms-card combinations, schema and firmware requirements. Do not promise cell-level data without finding it. |
| Powerchain | Discover members and inspect per-phase/per-inverter state. | Manager/worker routing and identity; account device enumeration alone does not establish topology. |
| Hardware and communication diagnostics | Extend `info` with decoded model names, component revisions and supported diagnostic counters. | Version-specific mappings, counter reset/wrap behavior, and whether a displayed diagnostic is a passive read or an active test. |

Useful primary starting points are Selectronic's
[managed AC-coupling link verification](https://web.selectronic.com.au/technotes/IN0061.html),
[Powerchain installation note](https://selectsupport.helpdocsite.com/installation-notes2/in0057-installation-of-an-sp-pro-powerchain-system),
and [software change history](https://www.selectronic.com.au/sppro/softwarehistory.htm).
The latter documents added BMS telemetry and compatibility requirements: features
in a newer SP LINK build need not exist in our older inverter firmware.

## 5. Make acquisition dependable enough to schedule

**Engineering proposals building on live-verified detailed retrieval.**

- **Offline decode and verification.** Recreate CSV from saved raw records, apply
  another timezone or local date filter, verify hashes, and compare decoder versions
  without reconnecting. Add a comparison tool for an independent SP LINK CSV,
  accounting for its rounding while reporting signs, units and timestamps separately.
- **Moving-buffer acquisition.** Our full download took about five minutes. The
  current implementation marks any metadata movement incomplete, so a one-minute
  logging configuration would defeat ordinary full-buffer downloads. Investigate
  provably stable record ranges or smaller acquisitions with overlap verification.
  Never simply disable the movement check.
- **Incremental capture and restart.** Re-read overlap and compare raw bytes plus
  metadata, rather than trusting a reused memory address or timestamp. Detect
  overwrite, clock changes, resets and lost retention. Preserve separate acquisition
  identities instead of silently appending incompatible snapshots.
- **Scheduled preservation.** Run bounded pulls comfortably inside measured
  retention, keep local manifests, and alert when successful acquisitions become
  stale. Use a per-device lock, backoff on busy/offline responses and a disk budget.
  Keep scheduling outside the core protocol library.
- **Archive filing.** Turn an acquisition into yearly CSVs and a coverage manifest
  using the supplied energy-monitoring convention. Parameterize destination and
  site details; preserve quantities, blanks, all observed columns and missing runs.
  Never overwrite a prior export session, including another run on the same day.

These improvements are useful even without adding another device command. They
also make a future choice of one-minute inverter logging practical: changing the
setting is a separate decision, with a much shorter retention window.

## 6. Use the evidence in LiveOne and other tools

**Engineering proposals; separate from protocol acquisition.**

- Build an outage report combining retained measurements and events, with explicit
  gaps and clock assumptions. Distinguish “the collector missed data” from an
  inverter-reported interruption where the evidence supports that distinction.
- Offer a separate importer into LiveOne with source identity, acquisition provenance,
  idempotency and explicit conflict handling. Validate CSV parity first. Fifteen-minute
  averages and accumulated counters must not masquerade as portal hourly buckets.
- Export live readings to a local dashboard, MQTT or a metrics endpoint. Preserve
  units and availability, keep credentials out of output, and define counter/reset
  semantics before presenting energy totals.

These are consumers of the standalone library/CLI, not reasons to add database or
Clerk dependencies to `lib/selectlive`.

## 7. Explore a direct local transport

**Documented connection options; interoperability remains to be tested.** SP LINK
supports USB, serial and Select.live connections, as described in Selectronic's
[connection FAQ](https://www.selectronic.com.au/support/faq.html).

A local serial or serial-over-network adapter could reuse the memory reader and
decoders while replacing the portal connection. It might permit collection during
an internet or portal outage. Validate framing, line settings, authentication and
actual adapter availability first; our cloud success does not prove local support.
Treat a plaintext serial bridge as local infrastructure, not a public endpoint.

## 8. Control and maintenance are a separate possible project

**Documented in SP LINK, not mapped or enabled here.** SP LINK includes operational
controls, configuration changes and service/firmware functions. These could enable
a narrowly scoped command to change the log interval, or eventually controlled
generator actions and maintenance. The relevant surfaces are in the
[manual, pp. 28–32, 74 and 93–98](https://www.selectronic.com.au/manuals/OI0005_31%20SP%20LINK%20Manual.pdf).

This would change the CLI's current read-only contract. Each operation would need
its own traced command sequence, supported-device checks, explicit intended value
or action, and post-operation verification. Setting writes, momentary button actions,
counter resets and firmware transfer have different interruption/retry semantics.
A generic memory-write command would not provide those guarantees. Firmware updates
and installer-only functions belong last, if pursued at all; the protocol's existence
does not establish that they work through every connection or firmware version.

### Generator control: a concrete protocol lead

Additional static analysis of SP LINK 16.11.9663 found the Quick View generator
button's path. **No generator control writes have been sent or live-tested.**

`fclsMain.picbBUTTON_Generator_MouseDown` calls `CommunicateButtonPress` with:

| Emulated SP PRO communications port | Generator button word address |
| --- | --- |
| 1 | `0xa232` (41522) |
| 2 | `0xa235` (41525) |

The value is `1` for a short press or `2` for a long press. The handler distinguishes
presses longer than one second. `CommunicateButtonPress` creates a one-word write
request, then queues reads of the same mailbox. It finishes when the returned value
is `0`; value `3` causes an already-pressed message. A mailbox acknowledgement is
not confirmation that the generator has started or stopped.

The address choice uses `SP_PROComportWeAreEmulating`, obtained from the low byte of
the reported communications-port value. We have not yet mapped that discovery path
into the CLI; do not hardcode a mailbox based only on using Select.live.

A short press requests a **toggle**, while the documented double-long-press action
relates to equalisation. A prospective `generator start` or `generator stop` must
first interpret current state, serialize control attempts, and verify the resulting
state. A timeout after sending a toggle is an unknown outcome, not permission to
retry it blindly. Check front-panel stop/cooldown semantics before equating this
with a normal automatic stop.

“Inhibit” needs a separate definition:

- **Scheduled lockout:** quiet hours, with low-battery override; not an unconditional stop.
- **Auto-start availability:** “Follow Input” uses a configured physical availability
  input. “Assume Always” does not. This is not evidence of a writable virtual input.
- **Controller disabled:** a persistent configuration setting, not a demonstrated
  temporary inhibit command. Behavior for an already-running generator needs testing.

These distinctions, remote-start input behavior and cooldown are documented in the
[manual, pp. 53, 64 and 74](https://www.selectronic.com.au/manuals/OI0005_31%20SP%20LINK%20Manual.pdf).
No dedicated software start/stop/inhibit latch has been established by this analysis.
Any timed software inhibit would also need defined expiry and failure behavior.

Read-only groundwork is unusually promising: `fnConvertGeneratorStatusValueToString`
and `fnConvertGeneratorStartedBySlashRunningReasonValueToString` expose state/reason
enums including starting, stopping, unavailable, fault, minimum runtime, lockout,
warming up and cooling down. Map their source registers and configuration first,
then design explicit actions around the observed state machine. The physical engine
interface remains the SP PRO's configured Run/Start outputs; supported wiring schemes
are described in [TN0025](https://selectsupport.helpdocsite.com/tech-notes2/tn0025-sp-pro-generator-controller-wiring-guide).

## Suggested order

1. Offline decode, independent SP LINK CSV comparison, and repeatable archive export.
2. Event download, to add explanations to the history we can already recover.
3. Typed live status and configuration snapshots, then a bounded watcher.
4. Daily summaries and dependable scheduled/incremental acquisition.
5. Attached-equipment diagnostics, direct local transport and downstream integrations
   according to actual site needs.

Maintain a small versioned register catalogue as these features grow: address,
length, unit, signedness, sentinel values, supported versions, evidence and read/write
classification. Extend the simulated-server fixtures for new layouts and preserve
small non-sensitive reference exports for decoder checks.

The limits remain: no recovery of overwritten intervals, no demonstrated second
one-minute buffer, no assumption that live telemetry is historical telemetry, and
no assumption that a feature present in SP LINK is available on every SP PRO.
