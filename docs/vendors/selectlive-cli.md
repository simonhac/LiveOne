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
