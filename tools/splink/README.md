# SP LINK static analysis

`extract_config_map.py` recovers the SP PRO's **configuration field map** — which word of
which memory block holds which setting, and how to convert it — and writes it to
[`lib/selectlive/config-map.json`](../../lib/selectlive/config-map.json).

Selectronic publishes no register map for the configuration blocks, so the map is recovered
by reading the IL of SP LINK's own shipped assembly. This is the same method, and the same
assembly, that produced `lib/selectlive/event-labels.json`. See
[`lib/selectlive/NOTICE.md`](../../lib/selectlive/NOTICE.md) for the attribution and
interoperability position.

## This does not run in CI, or at CLI time

Nothing in the app, the CLI or the test suite imports this. It is run by hand, offline, when
SP LINK is re-analysed — which in practice means when Selectronic ships a build that changes
the configuration layout. `dnfile` and `dncil` are deliberately **not** repository
dependencies; they live in a throwaway virtualenv built by the procedure below.

The vendor installer and assembly are **not** in this repository and must not be committed.

## Rebuilding the environment

The installer is public. Its SHA-256 is pinned in `extract_config_map.py`, and the script
refuses an assembly that is not the traced build unless `--allow-other-assembly` is passed.

```sh
WORK=/tmp/splink-rebuild && mkdir -p "$WORK" && cd "$WORK"

# 1. Fetch the installer and check it against the recorded provenance.
curl -sfL -o SP_LINK.msi https://www.selectronic.com.au/software/SP_LINK_16.11.9663.msi
shasum -a 256 SP_LINK.msi
#   expect bcfd24d5bf719b59e4097273d0d51e19b8eec0aa7bad685d1b98d2745d3ec49a

# 2. Carve the embedded CAB out of the MSI and unpack it.
#    macOS ships no msiextract/7z, but bsdtar reads CAB, and an MSI holds exactly one.
python3 -c "
import struct
d = open('SP_LINK.msi','rb').read()
i = d.find(b'MSCF')
open('payload.cab','wb').write(d[i:i+struct.unpack_from('<I', d, i+8)[0]])
"
mkdir -p cab && bsdtar -xf payload.cab -C cab

# 3. The managed assembly is the ~9 MB member. Confirm it.
shasum -a 256 cab/_4405DCB1DF921F4B991288BF338AAA93
#   expect 09725812ba9ca5af6a186b3290dcb6ac5f99f09f536e74558de612c2fa8278c8

# 4. Throwaway virtualenv for the IL readers.
python3 -m venv venv && ./venv/bin/pip install dnfile dncil
```

The CAB also carries the SP LINK manual as its ~14 MB member, if you need it.

## Regenerating the map

From the repository root:

```sh
/tmp/splink-rebuild/venv/bin/python3 tools/splink/extract_config_map.py \
    --assembly /tmp/splink-rebuild/cab/_4405DCB1DF921F4B991288BF338AAA93 \
    > lib/selectlive/config-map.json
```

Output is stable and sorted, so a regeneration diff is reviewable. `dnfile` prints
`invalid compressed int: leading byte: 0xf3` to stderr on this assembly; it is harmless
metadata noise from a table the script does not read.

## Enum tables

Combo-box settings are named from code-to-label tables read out of each converter's `switch`,
the same technique that produced `event-labels.json`. 32 tables are emitted.

🛑 **A generic switch reader can fabricate a plausible table.** `RegionSetting` builds its label
from a helper plus a text box; the switch found inside it belongs to unrelated percentage
strings and produced `{0: " ", 1: "20 %", 2: "0 %", 3: "20 %", 4: "20 %"}` — five codes, three
identical labels, and completely wrong. It is excluded by name in `ENUM_NOT_A_TABLE`, and any
table whose labels are mostly duplicates is now rejected and reported rather than emitted. If
you add a converter here, look at the table it produces before trusting it.

Two converters keep their labels in a helper rather than in themselves (`BaudRateSetting`,
`ShuntNameSetting`); those are listed in `ENUM_HELPERS`.

## What it checks before emitting anything

The script exits non-zero rather than write a plausible but wrong map. It fails if:

- any setting maps outside the words its block actually reads;
- a setting name maps to more than one word;
- `DetailedDataLogInterval` is not common word 54 — the anchor, because `0xc000 + 54` must
  equal `0xc036`, which is independently documented in
  `docs/vendors/selectlive-cli.md` and read by `lib/selectlive/history.ts`;
- any setting name looks like credential material (none does today);
- the battery block disagrees with `DefaultSettingsTemplate.BatterySettingDefaults`, whose
  **row order is the battery block's word order**. Two unrelated vendor structures agreeing
  across the whole block is much stronger evidence than either alone.

## Traps worth knowing before you edit it

- **Block lengths are stored minus one.** `clsMessage.SetWithCreatedReadRequest` takes
  `NumOfAddressLocationsToReadMinusOne`. The IL literals are 196/17/124/59/192; the real
  lengths are 197/18/125/60/193.
- **`ldc.i4.0`…`ldc.i4.8` are distinct opcodes**, not operands. An extractor that only
  handles `ldc.i4`/`ldc.i4.s` silently loses every array index 0–8 — which is most of the
  battery block, including the charge settings.
- **A widget getter opens a statement**, so it also closes the previous one. Without that
  boundary, a `Get` used as an `if` condition is attributed to the setting below it.
- **`DefaultSettingsTemplate..cctor` builds eight tables**, each ended by its own `stsfld`,
  and they reuse row numbers. Parsing it as one array interleaves them.
- **Those tables' columns are battery and application TYPES, not inverter models.**
- **`Get`, and the WinForms range setters, are MemberRefs**, not TypeDef methods, so the
  token resolver needs the MemberRef fallback or they come back as `token(0x0A...)`.
