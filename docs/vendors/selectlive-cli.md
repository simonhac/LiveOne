# Select.live exploration CLI

`selectlive` is a standalone SP PRO exploration tool. It connects directly through the
Select.live SP LINK tunnel, without LiveOne API, database, or Clerk credentials.

From the repository root:

```sh
./selectlive auth
./selectlive devices
./selectlive info --device 123456
./selectlive read --device 123456 --address 0xa007 --words 6
./selectlive history info --device 123456
./selectlive history download --device 123456 --out ./downloads --timezone Australia/Melbourne
```

`npm run selectlive -- <arguments>` also works. The launcher uses the repository's installed
`tsx`; run `npm install` if dependencies are absent. It does not modify shell startup files.
Output paths are relative to the caller's working directory, even when invoking the launcher
from another directory. Run `./selectlive <command> --help` for options. Human output is the
terminal default; piped output is JSON. Diagnostics and progress go to stderr.

## Authentication

`auth` and `auth login` prompt for the portal email and a hidden password, verify them over
TLS, then save them in `$XDG_CONFIG_HOME/selectlive/credentials.json`, falling back to
`~/.config/selectlive/credentials.json`. The directory is mode `0700`, the file `0600`.
This is a local plaintext credential file protected by filesystem permissions, not a token.
Replacement credentials are saved only after successful authentication.

`auth status` verifies the saved portal account and shows its email, without displaying
passwords. `auth logout` deletes the store. Environment overrides remain effective after logout.

For automation, set both `SELECTLIVE_EMAIL` and `SELECTLIVE_PASSWORD`. Supplying only one
is an error. Passwords cannot be passed as command-line flags. The CLI never reads LiveOne's
environment files automatically.

Portal login and inverter login are separate. `auth --device SERIAL` additionally verifies
and stores that inverter's password. It reuses the saved portal account unless environment
credentials override it. For device commands, inverter password precedence is:

1. `SELECTLIVE_INVERTER_PASSWORD`.
2. A password saved for this inverter under the same portal account.
3. The documented factory default, `Selectronic SP PRO`.

To automate `auth --device`, also set `SELECTLIVE_INVERTER_PASSWORD`. Switching portal accounts
clears the previous account's saved inverter passwords. Device selection uses inverter serials,
not portal dashboard system IDs. An account with one inverter selects it automatically; multiple
inverters require `--device`. The legacy list supplies serials only, not online status. Connecting
to a device distinguishes offline, busy, and rejected responses.

## History acquisition and export

A download creates a fresh `selectlive-SERIAL-*` directory containing:

- `records.jsonl`: original record bytes as hex with word addresses, newest records first.
- `manifest.json`: identity, firmware, format, timestamps, metadata before/after, completeness,
  raw-file SHA-256, acquired count, available coverage, and decoding status.
- `detailed.csv`: normalized columns with units in their names, when decoding succeeds.

Raw records are saved before decoding. Requests walk backward through the ring's sector table,
in batches of at most 256 words. Metadata and the newest record are checked afterward; changes
produce an **incomplete** manifest and no CSV. The tool does not lock or freeze inverter logging.
Retry when this occurs. Interrupts and failed transfers preserve successfully received records;
the initial manifest is incomplete even if the process is forcibly terminated. Its count/hash
may lag on a forced termination; `records.jsonl` remains the source of acquired records.

Formats 1–3 with 44-word entries are supported. Unknown layouts remain downloadable as raw
records but are not interpreted. Supported format coverage is based on stored record timestamps;
it is not a promise of continuous data or UTC coverage. `history info` reads the two boundary
records and reports whether metadata stayed stable during that inspection.

CSV requires `--timezone` describing the **inverter clock**, which may differ from the host's
local timezone. Without it, the tool preserves raw data and reports `timezone_required`.
The actual timestamp epoch is **2001-01-01**, despite SP LINK's internal conversion method name
mentioning 2000. `device_seconds_since_2001` and `device_time` preserve the original clock value;
`timestamp_utc` applies the supplied timezone. Ambiguous/nonexistent DST times cause CSV decoding
to fail explicitly while preserving raw data. If an inverter is configured to fixed standard
time, use the corresponding fixed-offset IANA zone rather than a daylight-saving zone.

Optional dates filter CSV locally and never reduce the raw download:

```sh
./selectlive history download --device 123456 --out ./downloads \
  --timezone Australia/Melbourne --start 2026-09-10 --end 2026-09-11
```

Start is inclusive, end exclusive, both midnight in the supplied timezone. Samples outside
that window remain in the raw file. CSV preserves SP LINK's native power signs and numeric
precision; most SP LINK CSV fields are rounded to two decimals. No energy deltas, interval
resampling, sign normalization, or LiveOne ingestion is performed. Accumulated energy readings
are exported as observed, including any resets/wraps.

Exit codes: `0` successful operation/decoded download; `1` no devices or preserved history
with incomplete/unsupported/not-decoded status; `2` usage; `3` authentication; `5` protocol,
network, or filesystem failure; `130` interrupted. Inspect `manifest.json` for download outcomes.

## Protocol evidence and boundaries

Research used the official [SP LINK installer](https://www.selectronic.com.au/software/SP_LINK_16.11.9663.msi),
version **16.11.9663**, SHA-256
`bcfd24d5bf719b59e4097273d0d51e19b8eec0aa7bad685d1b98d2745d3ec49a`.
The MSI was unpacked and its managed assembly inspected without running SP LINK. The following
interoperability facts were traced through `mSelectLive`, `mRawDataDownload`,
`clsShortTermRecord`, the receive dispatcher, and conversion routines:

| Word address | Meaning |
| --- | --- |
| `0x1f0000` | Eight-word login challenge and response mailbox |
| `0x1f0010` | Inverter login status |
| `0xa007` | Six interface/config/log-format version words; detailed version at offset 4 |
| `0xa032` | Firmware version encoded in hundredths |
| `0xa05d` | Model code followed by two little-endian serial words |
| `0xa335` | Five-word detailed-log header: sector count, entry size, current address (2 words), record count |
| `0xa33a` | Sector start/end pairs, each address two little-endian words; end inclusive |
| `0xa266` | Five-word **alert**-log header, same layout as `0xa335`; sector table follows at `0xa26b` |
| `0xa2a7` | Five-word **operational**-log header, same layout; sector table at `0xa2ac` |
| `0xa028` | Six-word installation scaling block: AC voltage, AC current, DC voltage, DC current, temperature, and one unidentified word |
| `0x1d0000` | Eight-word device clock, BCD: centiseconds, seconds, minutes, hours, day-of-week, day, month (bit 7 = century), year |
| `0xc036` | Configured detailed logging interval in minutes (read only) |
| `0xa374` / `0xa378` | Date-search request / response, deliberately unused |

The tunnel is TLS to `select.live:7528`: `LOGIN`, `USER:email:password`, `OK`,
`LIST DEVICES`, `CONNECT:serial`, `READY`, followed by the binary memory protocol.
TLS certificate and hostname verification remain enabled. The only supported write is the
MD5 challenge-response to the authentication mailbox. There are no configuration, clock,
firmware, date-search, or log-clear writes, and no general write command.

Detailed entries use little-endian 16-bit words. Words 0–1 are the timestamp; words 39–43
carry AC voltage/current, DC voltage/current, and temperature scales. Version 3 reuses words
29–30 for AC-coupled solar power/energy; earlier versions use temperatures. SOC `0xffff`,
temperature `0x7fff`, and version-3 solar `0xffff` represent missing readings.

The downloader uses the [selpi framing/authentication implementation](https://github.com/neerolyte/selpi/tree/68f144f0175a31a3ac1adf9019168d3ee26ee7b4)
as a reference; attribution is in `lib/selectlive/NOTICE.md`. Its published documentation is
less precise than its code about address width: queries use a **32-bit word address** and a
one-byte count-minus-one, permitting 1–256 words.

The [SP LINK manual Rev 31 (2024), page 58](https://download.selectronic.com.au/manuals/OI0005_31%20SP%20LINK%20Manual.pdf)
still describes four days at one minute, 60 days at 15 minutes, and 120 days at 30 minutes.
Actual coverage must be read from the device. The CLI cannot recover overwritten records.

One-minute logging is a configurable option for this same detailed buffer, not evidence of a
second, simultaneous one-minute archive. SP LINK's `fnGetDetailedDataLogInterval` and
`subUpdateDataLogIntervalSetting` map the setting directly to 1, 5, 10, 15, or 30 minutes;
`subLoadArrayToSettings_Common` reads common-configuration word 54 (`0xc036`). Changing
the interval would affect future logging, not reconstruct finer detail in existing records.
The CLI only reads this setting.

## Event logs

The SP PRO keeps two event rings, separate from the detailed log and from each other:

| Log | Records | What a record is |
| --- | --- | --- |
| `alert` | faults and their clearances | the code, the inverter's own timestamp, and an electrical/state snapshot |
| `operational` | state changes: relays, contactors, generator start/run reasons, sync detections | the same shape |

Both advertise **36-word** entries at events format version 3 (`0xa007` offset 3), and both use the
same descriptor layout as the detailed log — so `ringMetadata`, `validateMetadata` and `readBatches`
in `lib/selectlive/history.ts` traverse all three. Observed retention on firmware 12.25 differs
sharply between them: 52 alerts reaching back 15 months, against 910 operational records covering
one week.

Record layout (little-endian 16-bit words; words 16–21, 28–31 and 33 have no established meaning and
are preserved raw):

| Words | Meaning |
| --- | --- |
| 0–1 | timestamp, seconds since 2001-01-01 on the device's own clock |
| 2 | event code |
| 3–4 | DC voltage, DC mid-point voltage |
| 5–7 | inverter DC current, shunt 1, shunt 2 |
| 8–9, 10–11 | load AC power, inverter AC power (32-bit) |
| 12–15 | AC input power, AC load voltage, SOC (`0xffff` = missing), AC load frequency (centi-Hz) |
| 22–27 | inverter mode, charger status, contactor state, generator status, generator start reason, generator run reason |
| 32, 34, 35 | AC current, DC current and temperature scales as used when the record was written |

🛑 **Scaling factors are read, not assumed.** Words 32/34/35 supply three of them per record; AC
voltage and DC voltage come from the `0xa028` block. The incident scripts this decoder was ported
from carried `5300 / 1050 / 12000` as literals — correct for the Daylesford installation and for no
other — so a capture stores the block it actually read.

### Code labels

`lib/selectlive/event-labels.json` maps codes to descriptions: 308 alert codes, 369 operational
codes, and the five state enums above. They were resolved by offline IL inspection of the same
SP LINK 16.11.9663 assembly (`mDataConvert.fnConvert*ValueToString`), and the file carries its own
provenance block. An unknown code renders as `UNDECODED(n)`; a code the vendor table maps to an
empty string stays empty, because "the vendor has no name for this" and "we could not find it" are
different answers.

### Acquiring

`selectlive events info` reads both descriptors and the oldest/newest record present — which the
record *count* does not tell you, since a log can advertise 52 records spanning fifteen months.

`selectlive events download` walks newest-first and applies the same completeness discipline as the
detailed download: descriptor and newest record captured before the walk, both re-read afterwards
along with the oldest record actually read, each comparison reported separately.

`--resume <manifest.json>` reads only what is new, stopping one record **past** the previous
capture's anchor. Re-reading that anchor is deliberate: seeing it again proves nothing was missed in
between.

🛑 The three outcomes are distinct, and `overlapVerdict` in the manifest says which:

| Verdict | Meaning |
| --- | --- |
| `confirmed` | the anchor was seen again — nothing was missed |
| `lost` | the **whole retained ring** was walked and the anchor was not in it. Those records are gone from the inverter for good |
| `unverified` | the walk stopped early (deadline, abort, error) before reaching the anchor. This says nothing about whether those records still exist — retry |

Collapsing `unverified` into `lost` would announce permanent data loss on no evidence, and a
bounded acquisition produces exactly that outcome when a site is in trouble.

🛑 An anchor is only advanced by a **completed** walk. A partial acquisition keeps the previous
anchor, so the next `--resume` re-attempts the same gap rather than stepping over it.

Times are the inverter's own clock, stored verbatim. The manifest also records the clock's measured
offset from ours (45.9 s slow, measured 18 September 2026) as an observation; it is never applied to
a timestamp.

## Validation status

Offline tests cover framing/authentication, fragmented responses, failures, credential storage,
ring traversal, numeric conversions, timestamps, date filtering, and acquisition persistence.
The relevant suites pass 137 tests; the application and scripts TypeScript checks and Tier A
CLI conformance checks pass.

Authenticated live retrieval was verified on **2026-09-11**, against inverter **221452**,
firmware **12.25**, detailed format **3**, with 44-word records across 12 sectors. The full
download acquired **5,952 records** in 315 seconds, from 04:48:13 to 04:53:28 UTC.
Both metadata and the newest-record anchor remained unchanged. Raw-file SHA-256, record sizes,
counts, unique addresses, and unique timestamps were independently checked after acquisition.
CSV decoding succeeded for every record using `Australia/Melbourne`.

The inverter reports a **15-minute** configured interval. Retained device-clock coverage is
**2026-07-11 13:00 through 2026-09-11 14:45 AEST**. Of 5,951 adjacent timestamp pairs, 5,943
are 15 minutes apart and eight are 30 minutes apart; no one-minute records were found.
The eight gaps occur between physically adjacent records within sectors, rather than at
traversal boundaries. A complete acquisition means all advertised records were acquired;
it does not imply uninterrupted logging.

The production outage window `[2026-09-10 13:59, 2026-09-10 22:30)` UTC contains **34**
consecutive 15-minute record timestamps, from 14:00 through 22:15 UTC. The local acquisition
is preserved under `.context/selectlive/downloads/selectlive-221452-qaBAWc/`, with
`manifest.json`, `records.jsonl`, and `detailed.csv`. Validation results are in
`.context/selectlive/live-validation.json`. These files are local and gitignored; no LiveOne
ingestion was performed.

**CSV parity with SP LINK remains unverified.** Live retrieval and plausible decoded ranges
do not replace comparison against an independently generated SP LINK export. A reference CSV
for an overlapping window is still needed for that acceptance check.
