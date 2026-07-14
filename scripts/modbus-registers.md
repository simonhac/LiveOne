# DeepSea DSE7410 MkII — GenComm Modbus register reference

Reference for the Modbus registers we read from the DeepSea generator controller. The
machine-readable source of truth is the `REGISTERS` array in
[`packages/usher/clients/dse-client.ts`](../packages/usher/clients/dse-client.ts); this doc explains the _why_,
the decode rules, the enum/alarm interpretations, and the control/write path we deliberately
do **not** touch. Read the CLI live output with `npm run deepsea:poll` (Teleport VPN up).

## At a glance

|                |                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| Controller     | DeepSea **DSE7410 MkII** (DSE7400 MkII Auto-Mains-Failure / auto-start family)                                       |
| Protocol       | **DSE GenComm** over **Modbus TCP**                                                                                  |
| Transport      | host `10.0.1.244` (DHCP-reserved to its MAC), port **502**, **unit id 10** (DSE default, _not_ 1)                    |
| Function codes | GenComm uses **only FC3** (read holding registers) and **FC16** (write multiple). We issue **FC3 only** — read-only. |
| Reachability   | LAN-only; reachable from us only over the **Teleport VPN**                                                           |

## ⚠️ Read this first

- **Only Page-4 offsets 0–7 (addresses 1024–1031) are confirmed against the live controller.**
  Everything else is derived from the DSE GenComm standard **SP-228 REV A** (validated because
  its Page-4 table matches our proven anchors exactly) plus the Victron `dbus-modbus-client`
  `dse.py`. Treat every **~ / medium** and **~~ / low** row as _unverified_ until eyeballed live.
- **Addresses/scaling can be right in the spec yet still read `n/a` on this hardware.** A plain
  DSE7410 MkII has **no mains monitoring** and no mains CTs, so the whole Mains block is expected
  to be `null`. See [What won't populate](#what-wont-populate-on-a-plain-dse7410-mkii).
- **The control page (16) is a WRITE path that physically starts/stops the generator.** We do not
  write it. See [Control / write path](#control--write-path-page-16--not-used) for the safety notes.
- `057-004` is **not** the GenComm spec (it's the DSE CAN guide). DSE does not publish the full
  register map under a public number — it's supplied by DSE Technical Support on request. SP-228
  REV A (hosted by Winco) is a verbatim distribution of the standard.

## Live findings (2026-07-11)

First full read against the actual controller (over Teleport). The battery-voltage anchor
(13.7 V, 12 V system) and clock/run-time/starts all decoded correctly, confirming the addressing
and 32-bit math beyond Page-4. What the live data taught us:

- **The set is single-phase.** L1 registers read real values (0 V/A/W while stopped); L2/L3 return
  the sentinel → `null`. Same on the mains side. So for this asset, only L1 + the totals matter.
- **Genset was stopped** (Auto standby): `772 = Auto`, 0 rpm / 0 Hz / 0 W, all alarms clear.
  Run time **49.5 h**, **56** starts.
- **Engine operating state `1408` is unimplemented here** — it returns `0xFFFF`, not a state enum.
  Use **RPM (`1030`) / frequency (`1031`) / total power (`1536`)** as the "is it running" signal
  (Victron does the same: falls back to `RPM > 100`).
- **⚠ Generator kWh `1800` read 0 despite 49.5 h of run time.** Either the energy accumulator isn't
  populated on this unit (no power measured) or the address/scale is off. **Re-check `1800` while
  the genset is actually running and loaded** before trusting it as the energy signal.
- **Plant-battery `1880/1882` are unsupported** (Modbus exception 1, illegal function) → dropped.
- **Named-alarm count = 80** → 20 alarm words (`39425–39444`); all nibbles clear.
- **Controller clock `1792` looked ~8 h ahead of wall-clock time.** The epoch decode is correct,
  but the DSE's own clock/zone appears mis-set — verify it before relying on the maintenance
  timestamps (`1794/1796`), which are relative to it.
- **Sentinel band widened (bug fix).** A live power factor returned `0x7FFD`, a sentinel
  (under-range) that was being decoded as `327.65`. GenComm reserves the **top 8 codes** of each
  width, not just the top 2 — the client now treats the whole band as `null`.

## Addressing & decode rules

- **Absolute holding-register address = `page × 256 + offset`.** Read with FC3.
- **16-bit** values are one register; **32-bit** values are two registers, **most-significant-word
  first** (big-endian): `value = (reg[i] << 16) | reg[i+1]`, then two's-complement if signed, then
  `× scale`. _If a 32-bit value looks wildly wrong, try the swapped word order._
- **"Not available / out-of-range / fault" sentinels decode to `null`.** GenComm reserves the
  **top 8 codes** of each width (not just the top two — a live PF returned `0x7FFD`):

  | Width | Sentinel band → null        |
  | ----- | --------------------------- |
  | u16   | `0xFFF8` … `0xFFFF`         |
  | i16   | `0x7FF8` … `0x7FFF`         |
  | u32   | `0xFFFFFFF8` … `0xFFFFFFFF` |
  | i32   | `0x7FFFFFF8` … `0x7FFFFFFF` |

  On single-/split-phase sets the unused phases return the full-width sentinel → `null`.
  Some enums also carry a "not available" value that isn't in the sentinel band: engine-state `15`.

- **Mixed-width page hazard:** do **not** read a page as one contiguous all-32-bit block. Page 7
  interleaves 16-bit registers (e.g. Fuel Efficiency @ offset 100 / 1892) among 32-bit
  accumulators. The client reads each page in gap-aware **segments** and decodes per-field by
  `(offset, words)`, which handles the interleave — and, because segments split at large gaps,
  keeps an unsupported register (e.g. the hybrid plant-battery gap that returns _illegal function_)
  from failing the rest of the page.

## GenComm page allocation

| Page | Base addr | Contents                                                                      | Access    |
| ---: | --------: | ----------------------------------------------------------------------------- | --------- |
|    0 |         0 | GenComm info / version                                                        | R         |
|    3 |       768 | Module identity + control mode + status flags                                 | R         |
|    4 |      1024 | **Basic instrumentation** (engine + generator & mains AC)                     | R         |
|    5 |      1280 | Extended instrumentation (engine state @ 1408, …)                             | R         |
|    6 |      1536 | Derived instrumentation (power totals, PF, load %)                            | R         |
|    7 |      1792 | **Accumulated instrumentation** (run time, energy, starts, fuel, maintenance) | R/W       |
|    8 |      2048 | Legacy alarm conditions — **do not decode on a 74xx**, use Page 154           | R         |
|   16 |      4096 | **Control** (SCF support flags R; control-key write)                          | R + **W** |
|  154 |     39424 | Named alarm conditions (nibble-packed)                                        | R         |

## Register map (what the CLI reads)

Confidence: **H** = matches live anchors or two independent sources; **M** = single source but
plausible/internally consistent; **L** = arithmetic fine, label/offset uncorroborated. `Size`:
`u`/`i` = unsigned/signed, `16`/`32` = bits.

<!-- Tables generated from packages/usher/clients/dse-client.ts REGISTERS; keep in sync. -->

#### Engine

| Address | Page.Off | Field               | Size | Scale | Unit | Conf | Notes                       |
| ------: | :------: | ------------------- | :--: | :---: | :--: | :--: | --------------------------- |
|    1024 |   4.0    | Oil pressure        | u16  |  ×1   | kPa  |  H   | live-proven                 |
|    1025 |   4.1    | Coolant temperature | i16  |  ×1   |  °C  |  H   | live-proven                 |
|    1026 |   4.2    | Oil temperature     | i16  |  ×1   |  °C  |  H   | live-proven                 |
|    1027 |   4.3    | Fuel level          | u16  |  ×1   |  %   |  H   | live-proven                 |
|    1028 |   4.4    | Charge alt voltage  | u16  | ×0.1  |  V   |  H   | live-proven                 |
|    1029 |   4.5    | Battery voltage     | u16  | ×0.1  |  V   |  H   | live-proven (sanity anchor) |
|    1030 |   4.6    | Engine speed        | u16  |  ×1   | rpm  |  H   | live-proven                 |
|    1031 |   4.7    | Generator frequency | u16  | ×0.1  |  Hz  |  H   | live-proven                 |

#### Generator AC

| Address | Page.Off | Field                   | Size | Scale | Unit | Conf | Notes                                            |
| ------: | :------: | ----------------------- | :--: | :---: | :--: | :--: | ------------------------------------------------ |
|    1032 |   4.8    | Generator L1-N voltage  | u32  | ×0.1  |  V   |  H   |                                                  |
|    1034 |   4.10   | Generator L2-N voltage  | u32  | ×0.1  |  V   |  H   |                                                  |
|    1036 |   4.12   | Generator L3-N voltage  | u32  | ×0.1  |  V   |  H   |                                                  |
|    1038 |   4.14   | Generator L1-L2 voltage | u32  | ×0.1  |  V   |  M   | L-L block presence to confirm live               |
|    1040 |   4.16   | Generator L2-L3 voltage | u32  | ×0.1  |  V   |  M   |                                                  |
|    1042 |   4.18   | Generator L3-L1 voltage | u32  | ×0.1  |  V   |  M   |                                                  |
|    1044 |   4.20   | Generator L1 current    | u32  | ×0.1  |  A   |  H   |                                                  |
|    1046 |   4.22   | Generator L2 current    | u32  | ×0.1  |  A   |  H   |                                                  |
|    1048 |   4.24   | Generator L3 current    | u32  | ×0.1  |  A   |  H   |                                                  |
|    1050 |   4.26   | Generator earth current | u32  | ×0.1  |  A   |  M   | confirm sign/scale live                          |
|    1052 |   4.28   | Generator L1 real power | i32  |  ×1   |  W   |  H   | scale 1 W assumed; could be 0.1 kW — verify live |
|    1054 |   4.30   | Generator L2 real power | i32  |  ×1   |  W   |  H   |                                                  |
|    1056 |   4.32   | Generator L3 real power | i32  |  ×1   |  W   |  H   |                                                  |

#### Power (derived totals — Page 6)

| Address | Page.Off | Field                                   | Size | Scale | Unit | Conf | Notes                               |
| ------: | :------: | --------------------------------------- | :--: | :---: | :--: | :--: | ----------------------------------- |
|    1536 |   6.0    | Generator total real power              | i32  |  ×1   |  W   |  H   | **headline live-generation signal** |
|    1538 |   6.2    | Generator L1 apparent power             | u32  |  ×1   |  VA  |  M   |                                     |
|    1540 |   6.4    | Generator L2 apparent power             | u32  |  ×1   |  VA  |  M   |                                     |
|    1542 |   6.6    | Generator L3 apparent power             | u32  |  ×1   |  VA  |  M   |                                     |
|    1544 |   6.8    | Generator total apparent power          | i32  |  ×1   |  VA  |  M   |                                     |
|    1546 |   6.10   | Generator L1 reactive power             | i32  |  ×1   | var  |  M   |                                     |
|    1548 |   6.12   | Generator L2 reactive power             | i32  |  ×1   | var  |  M   |                                     |
|    1550 |   6.14   | Generator L3 reactive power             | i32  |  ×1   | var  |  M   |                                     |
|    1552 |   6.16   | Generator total reactive power          | i32  |  ×1   | var  |  M   |                                     |
|    1554 |   6.18   | Generator power factor L1               | i16  | ×0.01 |  —   |  M   |                                     |
|    1555 |   6.19   | Generator power factor L2               | i16  | ×0.01 |  —   |  M   |                                     |
|    1556 |   6.20   | Generator power factor L3               | i16  | ×0.01 |  —   |  M   |                                     |
|    1557 |   6.21   | Generator average power factor          | i16  | ×0.01 |  —   |  H   |                                     |
|    1558 |   6.22   | Generator load (% of full power)        | i16  | ×0.1  |  %   |  H   |                                     |
|    1559 |   6.23   | Generator reactive load (% of full var) | i16  | ×0.1  |  %   |  M   |                                     |

#### Energy (accumulators — Page 7)

| Address | Page.Off | Field                             | Size | Scale | Unit  | Conf | Notes                                      |
| ------: | :------: | --------------------------------- | :--: | :---: | :---: | :--: | ------------------------------------------ |
|    1800 |   7.8    | Generator positive kWh (exported) | u32  | ×0.1  |  kWh  |  H   | ×0.1 corroborated by Victron; confirm live |
|    1802 |   7.10   | Generator negative kWh (reverse)  | u32  | ×0.1  |  kWh  |  H   |                                            |
|    1804 |   7.12   | Generator kVAh                    | u32  | ×0.1  | kVAh  |  H   |                                            |
|    1806 |   7.14   | Generator kVArh                   | u32  | ×0.1  | kvarh |  H   |                                            |

#### Run stats / fuel / maintenance (Page 7)

| Address | Page.Off | Field                           | Size | Scale | Unit  | Conf | Notes                                                           |
| ------: | :------: | ------------------------------- | :--: | :---: | :---: | :--: | --------------------------------------------------------------- |
|    1792 |   7.0    | Controller clock                | u32  | epoch |   s   |  H   | Unix seconds; sanity-checks the maintenance timestamps          |
|    1794 |   7.2    | Time to next engine maintenance | i32  |  ×1   |   s   |  H   | **negative = overdue**                                          |
|    1796 |   7.4    | Time of next engine maintenance | u32  | epoch |   s   |  H   | absolute due date (Unix seconds)                                |
|    1798 |   7.6    | Engine run time                 | u32  |  ×1   |   s   |  H   | hours = value ÷ 3600                                            |
|    1808 |   7.16   | Number of engine starts         | u32  |  ×1   | count |  H   | live: 56                                                        |
|    1826 |   7.34   | Fuel used                       | u32  |  ×1   |   L   |  M   | unit L vs 0.1 L to confirm live; needs fuel sensing (live: n/a) |
|    1892 |  7.100   | Fuel efficiency (accumulated)   | u16  | ×0.01 | kWh/L |  M   | **lone 16-bit reg on page 7**                                   |

> Plant-battery run-time/cycles (offsets 88/90, addr 1880/1882) are a hybrid-controller
> feature — the live DSE7410 MkII returns **Modbus exception 1 (illegal function)** for them,
> so they are **not mapped**. See [live findings](#live-findings-2026-07-11).

#### Status (Page 3 + Page 4 + Page 5)

| Address | Page.Off | Field                                 | Size | Scale | Unit | Conf | Notes                                                                                           |
| ------: | :------: | ------------------------------------- | :--: | :---: | :--: | :--: | ----------------------------------------------------------------------------------------------- |
|     772 |   3.4    | Control / operating mode              | u16  | enum  |  —   |  H   | READ-ONLY; see [enum](#control--operating-mode-772). **Mode is changed via page 16, not here.** |
|     773 |   3.5    | Control mode selection                | u16  | enum  |  —   |  L   | usually `65535` (unimplemented) on a 7410                                                       |
|    1408 |  5.128   | Engine operating state                | u16  | enum  |  —   |  H   | see [enum](#engine-operating-state-1408)                                                        |
|    1072 |   4.48   | Mains voltage phase lag/lead (vs gen) | i16  |  ×1   |  °   |  M   | −180..+180                                                                                      |
|    1073 |   4.49   | Generator phase rotation              | u16  | enum  |  —   |  M   | see [phase rotation](#phase-rotation-1073-gen--1074-mains)                                      |
|    1074 |   4.50   | Mains phase rotation                  | u16  | enum  |  —   |  M   | same codes as gen phase rotation                                                                |

#### Identity (read once)

| Address | Page.Off | Field             | Size | Scale | Unit | Conf | Notes                                                        |
| ------: | :------: | ----------------- | :--: | :---: | :--: | :--: | ------------------------------------------------------------ |
|       9 |   0.9    | GenComm version   | u16  |  ×1   |  —   |  H   |                                                              |
|     768 |   3.0    | Manufacturer code | u16  |  ×1   |  —   |  H   | DSE = 1; combine with model to identify (Victron `"1-7410"`) |
|     769 |   3.1    | Model number      | u16  |  ×1   |  —   |  H   | e.g. 7410 / 7420                                             |
|     770 |   3.2    | Serial number     | u32  |  ×1   |  —   |  H   | 0..999,999,999                                               |

#### Alarms (Page 154 — nibble-packed)

`39424` = named-alarm count; `39425+` pack **4 alarms per register** as 4-bit nibbles (MSB-first).
See [Named-alarm decode](#named-alarm-decode-page-154). H for words 1–9 (SP-228 + a second source
agree); M for 10–20 (SP-228 only). Live count was **80** → 20 words.

|     Address | Page.Off  | Field                   | Conf |
| ----------: | :-------: | ----------------------- | :--: |
|       39424 |   154.0   | Named alarm count       |  H   |
| 39425–39433 |  154.1–9  | Named alarm words 1–9   |  H   |
| 39434–39444 | 154.10–20 | Named alarm words 10–20 |  M   |

#### Mains / utility — **conditional, expect `n/a` on a plain 7410**

| Address | Page.Off | Field                       | Size | Scale | Unit | Conf | Notes                                   |
| ------: | :------: | --------------------------- | :--: | :---: | :--: | :--: | --------------------------------------- |
|    1059 |   4.35   | Mains frequency             | u16  | ×0.1  |  Hz  |  M   | populates only if the unit senses mains |
|    1060 |   4.36   | Mains L1-N voltage          | u32  | ×0.1  |  V   |  M   |                                         |
|    1062 |   4.38   | Mains L2-N voltage          | u32  | ×0.1  |  V   |  M   |                                         |
|    1064 |   4.40   | Mains L3-N voltage          | u32  | ×0.1  |  V   |  M   |                                         |
|    1066 |   4.42   | Mains L1-L2 voltage         | u32  | ×0.1  |  V   |  M   |                                         |
|    1068 |   4.44   | Mains L2-L3 voltage         | u32  | ×0.1  |  V   |  M   |                                         |
|    1070 |   4.46   | Mains L3-L1 voltage         | u32  | ×0.1  |  V   |  M   |                                         |
|    1076 |   4.52   | Mains L1 current            | u32  | ×0.1  |  A   |  M   | needs a mains CT                        |
|    1078 |   4.54   | Mains L2 current            | u32  | ×0.1  |  A   |  M   | needs a mains CT                        |
|    1080 |   4.56   | Mains L3 current            | u32  | ×0.1  |  A   |  M   | needs a mains CT                        |
|    1084 |   4.60   | Mains L1 real power         | i32  |  ×1   |  W   |  M   | needs a mains CT                        |
|    1086 |   4.62   | Mains L2 real power         | i32  |  ×1   |  W   |  M   | needs a mains CT                        |
|    1088 |   4.64   | Mains L3 real power         | i32  |  ×1   |  W   |  M   | needs a mains CT                        |
|    1560 |   6.24   | Mains total real power      | i32  |  ×1   |  W   |  M   | needs a mains CT                        |
|    1810 |   7.18   | Mains positive kWh (import) | u32  | ×0.1  | kWh  |  M   | needs a mains CT                        |
|    1812 |   7.20   | Mains negative kWh (export) | u32  | ×0.1  | kWh  |  M   | needs a mains CT                        |

## Enum decodes

### Control / operating mode (772)

READ-ONLY. `0` Stop · `1` Auto · `2` Manual · `3` Test on load · `4` Auto w/ manual restore ·
`5` User configuration · `6` Test off load · `7` Off · `8–65534` reserved · `65535` unimplemented.
**You do not change mode by writing 772** — page 3 is read-only. Mode changes go via a control key
on page 16 (see below).

### Engine operating state (1408)

`0` Stopped · `1` Pre-start (preheat/crank) · `2` Warming up · `3` Running · `4` Cooling down ·
`5` Stopped (alt) · `6` Post-run · `15` Not available. Victron collapses this to
stopped/preheat/running/stopping and falls back to `RPM > 100` when unimplemented.

### Control unit status flags — alarm summary bitfield (774, not currently mapped)

16-bit, DSE numbers bits **1 = LSB … 16 = MSB**. Handy at-a-glance summary without decoding
Page 154: `bit13` shutdown active (`0x1000`) · `bit12` electrical trip (`0x0800`) · `bit11`
warning active (`0x0400`) · `bit10` telemetry alarm (`0x0200`) · `bit9` satellite telemetry
(`0x0100`) · `bit8` no font file (`0x0080`) · `bit7` controlled shutdown (`0x0040`) · `bit14`
control-unit failure (`0x2000`) · `bit16` not configured (`0x8000`). _"active" means ≥1 Page-154
named alarm is at that severity._ (Confidence for this word is only medium — corroborate live.)

### Phase rotation (1073 gen / 1074 mains)

`0` indeterminate · `1` L1→L2→L3 · `2` L3→L2→L1 · `3` phase error · `65535` unimplemented.

## Named-alarm decode (Page 154)

- `39424` holds the **count** of named alarms; the alarm words start at `39425`.
- Each subsequent register packs **4 alarms as 4-bit nibbles, MSB-first**:
  `state(n) = (reg >> (4 * (3 - position))) & 0xF` for the four positions in the word — i.e. the
  CLI shows nibbles `n0..n3` from the top of the word down.
- Nibble state codes (SP-228 note; the two sources differ slightly on labels — verify live):
  `0` = disabled / none · `1` = not active (no alarm present) · `2` = **warning** · `3` =
  **shutdown** · `4` = electrical trip · `15` = unimplemented.
- **Do not decode legacy Page 8 (`2048`) on a DSE7410 MkII** — SP-228 note 2 says the 74xx family
  uses Page 154. Page 8 exists but is unreliable for this controller.
- The specific alarm assigned to each nibble position is model-config-dependent; treat the CLI's
  nibble output as "which channels are lit and at what severity" and map to real conditions by
  observing the live panel, rather than trusting a hard-coded name list.

## Control / write path (Page 16) — **not used**

We map and read nothing here beyond documenting it. **These are the registers that remotely start
and stop the physical generator and change its operating mode.** GenComm effects control **only**
through this page — you cannot start/stop or change mode by writing page 3.

### How it works

- **`4096–4103` — SCF support map (READ-ONLY, 8 registers).** Bitfields advertising which System
  Control Function (SCF) codes the module supports. For SCF key `K`: `function_code = K − 35700`;
  register `= 4096 + ⌊function_code / 16⌋`; bit `= 15 − (function_code mod 16)`. Read this to
  confirm a function is available _before_ attempting a write.
- **`4104` — System control key (WRITE-ONLY).** `key = 35700 + function_code`.
- **`4105` — Key complement (WRITE-ONLY).** Must be `65535 − key`, written **together with 4104 in
  the same FC16 (write-multiple) transaction** as a 2-register write. The complement is an
  anti-corruption handshake; a missing/incorrect complement returns extended exception 7.
- Protected modules require an **access-level-2 password**; writes are **rate-limited (~10/s)**.

### Selected control keys (`key` / `complement`)

|  Fn | Action                        |   key | complement |
| --: | ----------------------------- | ----: | ---------: |
|   0 | Select **Stop** mode          | 35700 |      29835 |
|   1 | Select **Auto** mode          | 35701 |      29834 |
|   2 | Select **Manual** mode        | 35702 |      29833 |
|   3 | Select Test on load           | 35703 |      29832 |
|   5 | Start engine (in Manual/Test) | 35705 |      29830 |
|   6 | Mute alarm                    | 35706 |      29829 |
|   7 | Reset alarms                  | 35707 |      29828 |
|   8 | Transfer to generator         | 35708 |      29827 |
|   9 | Transfer to mains             | 35709 |      29826 |
|  10 | Reset mains failure           | 35710 |      29825 |
|  32 | **Telemetry start** (in Auto) | 35732 |      29803 |
|  33 | Cancel telemetry start        | 35733 |      29802 |
|  76 | Select Off mode               | 35776 |      29759 |
|  80 | Lamp test                     | 35780 |      29755 |

- **Remote start** = Auto (1) + Telemetry start (32), _or_ Manual (2) + Start engine (5).
- **Remote stop** = Stop (0).
- Example FC16 write for "Select Auto": write `[35701, 29834]` to registers `4104..4105`.

### ⚠️ Warnings before ever enabling writes

- **Safety first.** Writing these can crank and run an engine with no local warning. Never wire this
  up without confirming the physical set is safe to remote-start (no one servicing it, exhaust/fuel
  OK, transfer logic understood). This is an operational-safety change, not just a code change.
- **Separate initiative, not a monitoring feature.** The current integration is a read-only push
  vendor; adding writes means FC16, the SCF support-map pre-check, password handling, rate-limit
  backoff, and an authenticated/authorised command channel from the app to the LAN reader.
- **Check the support map first.** Read `4096–4103` and confirm the function's bit is set before
  writing its key; not all functions exist on all modules.
- **The complement is mandatory and paired.** Always write key + `65535−key` in one FC16; never
  write `4104` alone.

## What won't populate on a plain DSE7410 MkII

These are correctly mapped but will read `null` on this specific hardware (documented so a live
`n/a` isn't mistaken for a bug):

- **All Mains registers** — the DSE7410 MkII is the _auto-start-only_ variant with no mains
  monitoring (the DSE7420 MkII is the AMF variant). Mains V/freq populate only if it senses mains;
  mains current/power/energy additionally need a **mains CT** fitted.
- **Bus energy** (synchronising sets only), **Load/battery-charge kWh** (hybrid/ESS controllers),
  and **fuel used/efficiency** unless fuel sensing is configured.

## Other known GenComm registers (found but not mapped)

Documented for completeness; excluded from the CLI as low-value for this controller/app:

- **Bus accumulators** `1818` bus +kWh, `1820` bus −kWh, `1822` bus kVAh, `1824` bus kVArh — for
  synchronising controllers (86xx); a single 7410 won't populate them.
- **Hybrid/ESS** `1884` plant battery charge state (u16), `1886` load kWh, `1888` battery charging
  kWh, `1890` battery discharging kWh — storage-controller features.
- **Maintenance alarm sets 2 & 3** `1836/1838`, `1840/1842`, `1844/1846` (time-to / time-of, per
  schedule) — we map only schedule 1 (`1794/1796`).
- **Sequence-component voltages** (mains `1250/1252/1254`), **mains high-res frequency** `1487`
  (u16 ×0.01), **mains earth current** `1082`, **engine % load at rated speed** `1354` — niche.
- **Legacy Page-8 alarms** `2048` — superseded by Page 154 on the 74xx family; do not decode.
- **Human-readable identity strings** live on Page 24 (not mapped).

## Verify-live checklist (VPN up; genset stopped, then running)

Run `npm run deepsea:poll` (add `--raw` to see raw words). Confirm:

- [ ] Battery voltage sensible (the CLI's built-in anchor) → addressing/scaling proven.
- [ ] Per-phase watts `1052/54/56` scale — **1 W vs 0.1 kW** (should ≈ Σ ≈ total `1536`).
- [ ] Generator kWh `1800` resolution (×0.1) — watch a live delta while running.
- [ ] Fuel used `1826` unit (L vs 0.1 L) and fuel efficiency `1892`.
- [ ] Earth current `1050` sign/scale; L-L voltage block `1038/40/42` presence.
- [ ] Mains block — real values (→ this unit is actually AMF-class with CTs) or `n/a` (expected).
- [ ] Engine state `1408` and control mode `772` enums match the panel while you toggle it.
- [ ] Named-alarm nibbles `39425+` light up as expected when you trigger a test alarm.

## Sources

- **DSE GenComm standard, SP-228 REV A** (verbatim distribution, hosted by Winco): the primary
  register map. Its Page-4 basic-instrumentation table matches our live anchors exactly, which
  validates the `page×256+offset` addressing and scaling convention for the rest of the document.
- **Victron `dbus-modbus-client` `dse.py`** (github.com/victronenergy/dbus-modbus-client): an
  independent code cross-check for the mode (772), engine-state (1408), energy ×0.1 scaling (1800),
  run time (1798), starts (1808), and the control-key pair (35701/35732/35733).
- **DSE7410 MkII & DSE7420 MkII Operator Manual** `057-263`; **Configuration Suite manual** `057-262`.
- Ground truth: `packages/usher/clients/dse-client.ts` (Page-4 offsets 0–7, proven live 2026-07-10).
