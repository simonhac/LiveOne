#!/usr/bin/env python3
"""Recover the SP PRO's configuration field map from the SP LINK assembly.

SP LINK reads the inverter's configuration as five blocks of raw 16-bit words and then
distributes those words across its configuration tabs. The distribution IS the field map:
which word holds the bulk charge current, and how to turn it into amps. Nothing published
by Selectronic describes it, so it is recovered here by offline inspection of the shipped
.NET assembly's IL, the same way `lib/selectlive/event-labels.json` was.

This runs by hand, offline, at most when SP LINK is re-analysed. Nothing at CLI time or in
CI depends on it. See README.md for the environment it needs -- `dnfile` and `dncil` are
deliberately not repository dependencies, and no vendor binary is redistributed here.

Usage:
    python3 tools/splink/extract_config_map.py --assembly <path> \
        > lib/selectlive/config-map.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

import dnfile
from dncil.cil.body.reader import read_method_body_from_bytes
from dncil.clr.token import Token

# The assembly this map was traced from. A different build may lay the blocks out
# differently, so the hash is checked rather than trusted.
EXPECTED_ASSEMBLY_SHA256 = (
    "09725812ba9ca5af6a186b3290dcb6ac5f99f09f536e74558de612c2fa8278c8"
)
VENDOR_SOFTWARE = "SP LINK 16.11.9663"
INSTALLER_SHA256 = "bcfd24d5bf719b59e4097273d0d51e19b8eec0aa7bad685d1b98d2745d3ec49a"

# The five reads issued by mConfig.DownloadOneInvertersConfig.
#
# 🛑 The IL literals are each one LESS than `words` here. The vendor's parameter is named
# `NumOfAddressLocationsToReadMinusOne` and is stored straight into frame byte 1 -- the same
# encoding `lib/selectlive/protocol.ts` writes. `words` below is the decoded count.
BLOCKS = [
    {"name": "common", "address": 0xC000, "words": 197, "splinkSection": 48},
    {"name": "commonPart2", "address": 0xC0E5, "words": 18, "splinkSection": 49},
    {"name": "application", "address": 0xC100, "words": 125, "splinkSection": 50},
    {"name": "battery", "address": 0xC180, "words": 60, "splinkSection": 51},
    {"name": "scheduler", "address": 0xC800, "words": 193, "splinkSection": 52},
]

# SP LINK merges common part 1 and part 2 into one indexed array before decoding, so the
# decode methods address a single `common` block. Its length is derived from the two reads in
# `extract_blocks`, not fixed here -- see the `--allow-other-assembly` note in build().

# Which vendor decode method fills which merged block.
DECODE_METHODS = {
    "mConfig.subLoadArrayToSettings_Common": "common",
    "mConfig.subLoadArrayToSettings_AppType": "application",
    "mConfig.subLoadArrayToSettings_BattType": "battery",
    "mConfig.subLoadArrayToSettings_SystemScheduler": "scheduler",
}

# Control-name prefixes SP LINK uses for its configuration widgets. Stripping the prefix
# yields the canonical setting name used by DefaultSettingsTemplate.
CONTROL_PREFIXES = ("nud", "cb", "dtp", "tb", "lbl", "chk", "rb", "txt")

# A setting name matching this is credential material and must never reach an artefact.
# Nothing in the five blocks matches today; this exists so that a future re-extraction
# that introduces one fails loudly here rather than silently publishing it.
SENSITIVE_NAME = re.compile(r"password|passcode|pwd|secret|token|apikey", re.IGNORECASE)


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Assembly:
    """Minimal IL reader over the SP LINK assembly."""

    def __init__(self, path: Path) -> None:
        self.pe = dnfile.dnPE(str(path))
        self._names: dict[tuple[int, int], str] = {}
        for type_def in self.pe.net.mdtables.TypeDef.rows:
            for method in type_def.MethodList:
                self._names[(6, method.row_index)] = (
                    f"{type_def.TypeName}.{method.row.Name}"
                )
            for field in type_def.FieldList:
                self._names[(4, field.row_index)] = (
                    f"{type_def.TypeName}.{field.row.Name}"
                )

    def resolve(self, operand: Any) -> str:
        if not isinstance(operand, Token):
            return "" if operand is None else str(operand)
        if operand.table == 0x70:  # user string heap
            try:
                return self.pe.net.user_strings.get(operand.rid).value
            except Exception:
                return ""
        known = self._names.get((operand.table, operand.rid))
        if known is not None:
            return known
        # MemberRef and friends: framework and cross-assembly calls such as the array
        # accessor `Get` and the WinForms range setters. Their bare name is enough.
        table = self.pe.net.mdtables.tables.get(operand.table)
        if table is not None and 0 < operand.rid <= len(table.rows):
            row = table.rows[operand.rid - 1]
            return str(getattr(row, "Name", getattr(row, "TypeName", operand)))
        return str(operand)

    def instructions(self, name: str) -> list[tuple[int, str, Any, str]]:
        """(IL offset, opcode, raw operand, resolved operand) for one method, by full name."""
        for type_def in self.pe.net.mdtables.TypeDef.rows:
            for method_index in type_def.MethodList:
                method = method_index.row
                if f"{type_def.TypeName}.{method.Name}" != name or not method.Rva:
                    continue
                body = read_method_body_from_bytes(self.pe.get_data(method.Rva, 1000000))
                return [
                    (i.offset, i.opcode.name, i.operand, self.resolve(i.operand))
                    for i in body.instructions
                ]
        raise LookupError(f"method not found: {name}")

    def params(self, name: str) -> list[str]:
        for type_def in self.pe.net.mdtables.TypeDef.rows:
            for method_index in type_def.MethodList:
                method = method_index.row
                if f"{type_def.TypeName}.{method.Name}" == name:
                    return [str(p.row.Name) for p in method.ParamList]
        raise LookupError(f"method not found: {name}")

    def method_names(self) -> list[str]:
        out = []
        for type_def in self.pe.net.mdtables.TypeDef.rows:
            for method_index in type_def.MethodList:
                out.append(f"{type_def.TypeName}.{method_index.row.Name}")
        return out


def int_operand(opcode: str, operand: Any) -> int | None:
    """Decode an ldc.i4 family push, including the single-byte short forms.

    🛑 The short forms matter: an extractor that only handles `ldc.i4` and `ldc.i4.s`
    silently loses every array index 0-8, which is most of the battery block.
    """
    if opcode in ("ldc.i4", "ldc.i4.s"):
        return int(operand)
    short = re.fullmatch(r"ldc\.i4\.(\d)", opcode)
    if short:
        return int(short.group(1))
    if opcode == "ldc.i4.m1":
        return -1
    return None


def canonical_name(control: str) -> str:
    for prefix in CONTROL_PREFIXES:
        if control.startswith(prefix) and len(control) > len(prefix):
            rest = control[len(prefix) :]
            # A digit counts: nud5MinuteAverageBatteryToStartGenerator.
            if rest[0].isupper() or rest[0].isdigit():
                return rest
    return control


VERSION_FIELD = "mGLOBALS.InverterConfigurationSettingsVersionNumber"


def version_guards(
    instructions: list[tuple[int, str, Any, str]],
) -> tuple[list[tuple[int, int, str, int]], int]:
    """Where the decode methods gate a setting on the configuration-settings version.

    🛑 These gates are FEATURE AVAILABILITY, not a different layout. The vendor emits

        if version >= 15 then nudMaxDaysBetweenPeriodicRecharge = array.Get(0, 44)

    so word 44 means the same thing at every version; it simply does not exist before 15. That
    makes "minimum version per setting" the right model, and a single global floor the wrong
    one -- a floor set to the highest gate anywhere would refuse an entire device over one
    feature it does not have.

    Returns (guards, unmodelled), where each guard is (start, end, kind, version) over IL
    offsets and `kind` is "min" or "max". `unmodelled` counts version tests written as a
    compound condition (`clt.un` feeding a boolean) rather than a direct branch; those are
    reported rather than guessed at.
    """
    guards: list[tuple[int, int, str, int]] = []
    unmodelled = 0
    for i, (_offset, _opcode, _operand, resolved) in enumerate(instructions):
        if resolved != VERSION_FIELD or i + 2 >= len(instructions):
            continue
        _, constant_op, constant_raw, _ = instructions[i + 1]
        branch_offset, branch_op, branch_raw, _ = instructions[i + 2]
        version = int_operand(constant_op, constant_raw)
        if version is None:
            continue
        # `blt.un target` == "if version < N skip ahead", so the skipped span needs >= N.
        if branch_op.startswith("blt.un"):
            guards.append((branch_offset, int(branch_raw), "min", version))
        # `bge.un target` == the inverse: a legacy span that applies only below N.
        elif branch_op.startswith("bge.un"):
            guards.append((branch_offset, int(branch_raw), "max", version - 1))
        else:
            unmodelled += 1
    return guards, unmodelled


def applicable_versions(
    guards: list[tuple[int, int, str, int]], offset: int
) -> tuple[int, int | None]:
    """(minimum version, maximum version) for a setting assigned at this IL offset."""
    minimum = 0
    maximum: int | None = None
    for start, end, kind, version in guards:
        if not start <= offset < end:
            continue
        if kind == "min":
            minimum = max(minimum, version)
        else:
            maximum = version if maximum is None else min(maximum, version)
    return minimum, maximum


def extract_blocks(asm: Assembly) -> list[dict[str, Any]]:
    """The five reads, taken from the assembly rather than trusted from a constant.

    🛑 `BLOCKS` above is a convenience and an expectation, not a source of truth. Without this,
    `--allow-other-assembly` would bypass only the hash check while the addresses stayed pinned
    to 16.11.9663 — so a future build that moved a range would pass every check and produce a
    map that reads stale or unrelated words with full confidence.

    Each read compiles to `SetWithCreatedReadRequest(address, wordsMinusOne, section)`, and the
    section tag is what names the block: the vendor's own routing number for the response.
    """
    sections = {
        48: "common",
        49: "commonPart2",
        50: "application",
        51: "battery",
        52: "scheduler",
    }
    blocks: list[dict[str, Any]] = []
    constants: list[int] = []
    for _offset, opcode, operand, resolved in asm.instructions(
        "mConfig.DownloadOneInvertersConfig"
    ):
        value = int_operand(opcode, operand)
        if value is not None:
            constants.append(value)
            continue
        if not (
            opcode.startswith("call")
            and resolved.endswith("SetWithCreatedReadRequest")
        ):
            if opcode.startswith("call"):
                constants = []
            continue
        if len(constants) < 3:
            raise RuntimeError(
                "SetWithCreatedReadRequest call with fewer than three constant arguments; "
                "the read-extraction assumption is wrong."
            )
        address, words_minus_one, section = constants[-3:]
        name = sections.get(section)
        if name is None:
            raise RuntimeError(
                f"unrecognised SP LINK section {section} reading 0x{address:04x}; the "
                "configuration blocks have changed and this script needs revisiting."
            )
        blocks.append(
            {
                "name": name,
                "address": address,
                # 🛑 Plus one: the parameter is NumOfAddressLocationsToReadMinusOne.
                "words": words_minus_one + 1,
                "splinkSection": section,
            }
        )
        constants = []
    return blocks

def extract_settings(asm: Assembly) -> list[dict[str, Any]]:
    """Recover (setting -> block, word index, converter) from the four decode methods.

    Each setting is one statement in the vendor source, and compiles to a recognisable run:

        callvirt fclsMain.get_<control>          # the widget being filled
        ... ldc.i4 <phase> ldc.i4 <index> callvirt Get      # the word(s) it reads
        call mConfig.subUpdate<Kind>Setting      # scaling / enum conversion
        callvirt fclsMain.set_<control>          # widget written back

    🛑 The anchor is the converter call, and the `Get`s attributed to it are only those
    since the most recent setter of ANY kind. The decode methods also contain
    `set_Minimum` / `set_Maximum` range statements that read their own words; attributing
    those to the next real setting shifts indices and produces plausible wrong values.
    """
    settings: list[dict[str, Any]] = []
    unmodelled_guards = 0
    for method, block in DECODE_METHODS.items():
        instructions = asm.instructions(method)
        guards, unmodelled = version_guards(instructions)
        unmodelled_guards += unmodelled
        pending_gets: list[tuple[int, int]] = []
        constants: list[int] = []

        for position, (offset, opcode, operand, resolved) in enumerate(instructions):
            value = int_operand(opcode, operand)
            if value is not None:
                constants.append(value)
                continue

            if opcode.startswith("call") and resolved == "Get":
                # Get(dim0, dim1): dim0 is the multi-phase phase, dim1 the word index.
                if len(constants) >= 2:
                    pending_gets.append((constants[-2], constants[-1]))
                constants = []
                continue

            if opcode.startswith("call") and re.search(r"\.set_|^set_", resolved):
                # A completed statement of any kind. Range setters read words too.
                pending_gets = []
                constants = []
                continue

            if opcode.startswith("call") and re.fullmatch(r"fclsMain\.get_\w+", resolved):
                # 🛑 A widget getter opens the assignment statement, so it also closes the
                # previous one. Without this, a `Get` used as an `if` condition just above
                # gets attributed to the setting below it -- observed on SoCMonitor, which
                # sits under a guard reading the same block and came out as index [6, 6].
                pending_gets = []
                constants = []
                continue

            converter = re.fullmatch(r"mConfig\.subUpdate(\w+)", resolved)
            if not (opcode.startswith("call") and converter):
                if opcode.startswith("call"):
                    constants = []
                continue

            control = _following_setter(instructions, position)
            if control is None:
                raise RuntimeError(
                    f"{method}: {resolved} at instruction {position} has no following "
                    "control setter; the anchoring assumption is wrong."
                )
            if pending_gets:
                minimum, maximum = applicable_versions(guards, offset)
                settings.append(
                    {
                        "name": canonical_name(control),
                        "control": control,
                        "block": block,
                        "phase": pending_gets[0][0],
                        "index": [index for _, index in pending_gets],
                        "converter": converter.group(1),
                        "minVersion": minimum,
                        **({"maxVersion": maximum} if maximum is not None else {}),
                    }
                )
            pending_gets = []
            constants = []

    if unmodelled_guards:
        print(
            f"note: {unmodelled_guards} version tests are compound conditions and were not "
            "modelled; those settings are emitted as ungated.",
            file=sys.stderr,
        )
    return settings


def _following_setter(
    instructions: list[tuple[int, str, Any, str]], start: int, window: int = 40
) -> str | None:
    """The control this statement writes back to, i.e. the setting's name."""
    for _offset, opcode, _operand, resolved in instructions[start + 1 : start + 1 + window]:
        match = re.fullmatch(r"fclsMain\.set_(\w+)", resolved)
        if opcode.startswith("call") and match:
            return match.group(1)
    return None


def extract_string_array(asm: Assembly, method: str, field: str) -> list[str]:
    """A static `string[]` built inline in a class constructor."""
    pending: dict[int, str] = {}
    index: int | None = None
    for _offset, opcode, operand, resolved in asm.instructions(method):
        value = int_operand(opcode, operand)
        if value is not None:
            index = value
            continue
        if opcode == "ldstr":
            pending[index if index is not None else len(pending)] = resolved
            continue
        if opcode == "newarr":
            pending = {}
            index = None
            continue
        if opcode == "stsfld" and resolved == field:
            return [pending.get(i, "") for i in range(max(pending) + 1)] if pending else []
    raise LookupError(f"{field} not initialised in {method}")


def extract_index_to_int(asm: Assembly, method: str, array_field: str) -> dict[int, int]:
    """A `Select Case` over `array(i)` returning an integer, as index -> value.

    `GetInvertersBatteryCellCount` and its siblings compile to a chain of string
    comparisons against `SP_PRO_ModelNumbers(i)`, each arm returning a literal.
    """
    mapping: dict[int, int] = {}
    slot: int | None = None
    pending_index: int | None = None
    saw_array = False
    for _offset, opcode, operand, resolved in asm.instructions(method):
        if opcode == "ldsfld" and resolved == array_field:
            saw_array = True
            pending_index = None
            continue
        value = int_operand(opcode, operand)
        if value is not None:
            if saw_array and pending_index is None:
                pending_index = value
            else:
                slot = value
            continue
        if opcode == "ldelem.ref":
            saw_array = False
            continue
        if opcode == "ret" and pending_index is not None and slot is not None:
            mapping[pending_index] = slot
            # 🛑 Reset the index too. The method ends with a fall-through error arm that
            # returns a default; leaving `pending_index` set makes that arm overwrite the
            # last real model -- observed as SPMC480 reporting 0 cells instead of 24.
            pending_index = None
            slot = None
    return mapping


def extract_models(asm: Assembly) -> dict[str, dict[str, Any]]:
    """Model code -> model string, battery cell count and nominal battery voltage.

    🛑 `subUpdateDCVoltageSetting` is `raw x cellCount / 1000`, so every DC-voltage setting
    is meaningless without this table: the same word reads 57.6 V on a 48 V SPMC482 and
    28.8 V on a 24 V SPMC241.
    """
    names = extract_string_array(asm, "mGLOBALS..cctor", "mGLOBALS.SP_PRO_ModelNumbers")
    cells = extract_index_to_int(
        asm, "mGLOBALS.GetInvertersBatteryCellCount", "mGLOBALS.SP_PRO_ModelNumbers"
    )
    models: dict[str, dict[str, Any]] = {}
    for code, model in enumerate(names):
        if not model:
            continue
        cell_count = cells.get(code)
        if cell_count is None:
            continue
        models[str(code)] = {
            "model": model,
            "batteryCells": cell_count,
            # Each cell is a nominal 2 V lead-acid cell in SP LINK's model.
            "nominalBatteryVoltage": cell_count * 2,
        }
    return models


def extract_default_tables(
    asm: Assembly,
) -> tuple[dict[str, dict[str, list[str]]], dict[str, dict[int, str]]]:
    """The `DefaultSettingsTemplate` tables.

    Returns (defaults, rowOrder): defaults is table -> setting name -> per-type default
    values; rowOrder is table -> row number -> setting name, which is what the battery
    cross-check needs. One pass, because this method is ~20,000 instructions.

    🛑 One method builds EIGHT separate tables, each finished by its own `stsfld`, and they
    reuse row numbers. Parsing it as a single array silently interleaves them --
    `BulkChargeI` appears in both `BatterySettingDefaults` (row 11) and
    `DefaultConfigurationFile` (row 369), and whichever is seen last wins.

    🛑 The columns are NOT inverter models. `BatterySettingDefaults` has 20 columns, one per
    battery TYPE preset; `ApplicationSettingDefaults` has 4, one per application type. So a
    default is only meaningful once the configured type is known, which is why nothing here
    computes a "differs from default" flag.
    """
    wanted = ("BatterySettingDefaults", "ApplicationSettingDefaults")
    tables: dict[str, dict[int, dict[int, str]]] = {}
    rows: dict[int, dict[int, str]] = {}
    constants: list[int] = []
    for _offset, opcode, operand, resolved in asm.instructions("DefaultSettingsTemplate..cctor"):
        value = int_operand(opcode, operand)
        if value is not None:
            constants.append(value)
            continue
        if opcode == "ldstr" and len(constants) >= 2:
            rows.setdefault(constants[-2], {})[constants[-1]] = resolved
            continue
        if opcode == "stsfld" and resolved.startswith("DefaultSettingsTemplate."):
            tables[resolved.split(".", 1)[1]] = rows
            rows = {}
            constants = []
            continue
        if opcode.startswith("call"):
            constants = []

    defaults: dict[str, dict[str, list[str]]] = {}
    row_order: dict[str, dict[int, str]] = {}
    for table in wanted:
        content = tables.get(table)
        if not content:
            continue
        width = max((max(r) for r in content.values() if r), default=0)
        defaults[table] = {
            row[0]: [row.get(c, "") for c in range(1, width + 1)]
            for row in content.values()
            if row.get(0)
        }
        row_order[table] = {n: row[0] for n, row in content.items() if row.get(0)}
    return defaults, row_order


def check_battery_row_order(
    row_order: dict[str, dict[int, str]], settings: list[dict[str, Any]]
) -> list[str]:
    """Cross-check the battery block against an unrelated vendor table.

    `BatterySettingDefaults` is a defaults table, not a memory map, but its ROW ORDER is the
    battery block's word order -- row 11 is `BulkChargeI`, which is also battery word 11.
    Two independent vendor structures agreeing across the whole block is much stronger
    evidence than either alone, so a disagreement is an extraction failure, not a warning.
    """
    rows = row_order.get("BatterySettingDefaults")
    if not rows:
        return ["BatterySettingDefaults not found; row-order cross-check skipped"]
    problems = []
    for setting in settings:
        if setting["block"] != "battery" or len(setting["index"]) != 1:
            continue
        expected = rows.get(setting["index"][0])
        if expected and expected != setting["name"]:
            problems.append(
                f"battery word {setting['index'][0]}: decode methods say "
                f"{setting['name']!r}, BatterySettingDefaults says {expected!r}"
            )
    return problems


def dedupe(settings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse settings the vendor assigns more than once.

    Two shapes occur, both benign:

    - The same widget filled on both arms of a branch, producing identical records.
    - The same word assigned in adjacent version spans, e.g. `KacoPort` at application word 66
      for versions 16-17 and again for 18 and up. The vendor is changing the widget's contents,
      not the word, so the setting's real window is the UNION of the spans.

    Anything else -- one name at two different words -- is left alone so `self_check` fails on
    it, because that would mean the version model is wrong.
    """
    merged: dict[tuple[Any, ...], dict[str, Any]] = {}
    order: list[tuple[Any, ...]] = []
    for setting in settings:
        key = (
            setting["name"],
            setting["block"],
            tuple(setting["index"]),
            setting["phase"],
            setting["converter"],
        )
        existing = merged.get(key)
        if existing is None:
            merged[key] = dict(setting)
            order.append(key)
            continue
        existing["minVersion"] = min(existing["minVersion"], setting["minVersion"])
        # An open-ended span absorbs a bounded one: the setting exists from the lower bound on.
        if "maxVersion" not in setting or "maxVersion" not in existing:
            existing.pop("maxVersion", None)
        else:
            existing["maxVersion"] = max(existing["maxVersion"], setting["maxVersion"])
    return [merged[key] for key in order]


def merged_words(blocks: list[dict[str, Any]]) -> dict[str, int]:
    """Words per indexed block, with the two common reads concatenated as the vendor does."""
    by_name = {block["name"]: block["words"] for block in blocks}
    return {
        "common": by_name["common"] + by_name["commonPart2"],
        "application": by_name["application"],
        "battery": by_name["battery"],
        "scheduler": by_name["scheduler"],
    }


def self_check(
    settings: list[dict[str, Any]],
    row_order: dict[str, dict[int, str]],
    limits: dict[str, int],
) -> list[str]:
    """Everything that, if wrong, would publish a plausible but false field map."""
    problems: list[str] = []

    for setting in settings:
        limit = limits[setting["block"]]
        for index in setting["index"]:
            if not 0 <= index < limit:
                problems.append(
                    f"{setting['name']}: {setting['block']} word {index} is outside the "
                    f"{limit} words actually read"
                )

    by_name: dict[str, set[str]] = {}
    for setting in settings:
        by_name.setdefault(setting["name"], set()).add(
            f"{setting['block']}{setting['index']}"
        )
    for name, places in by_name.items():
        if len(places) > 1:
            problems.append(f"{name}: mapped to more than one word: {sorted(places)}")

    # The anchor. `0xc036` is independently documented in docs/vendors/selectlive-cli.md
    # and read by lib/selectlive/history.ts, so common word 54 is a fact we can check
    # against something outside this script.
    interval = [s for s in settings if s["name"] == "DetailedDataLogInterval"]
    if len(interval) != 1 or interval[0]["block"] != "common":
        problems.append("DetailedDataLogInterval not found in the common block")
    elif interval[0]["index"] != [54]:
        problems.append(
            f"DetailedDataLogInterval is common word {interval[0]['index']}, expected [54] "
            f"so that 0xc000 + 54 == 0xc036"
        )

    for setting in settings:
        if SENSITIVE_NAME.search(setting["name"]):
            problems.append(
                f"{setting['name']}: looks like credential material. Nothing in these five "
                "blocks did when this was written; decide deliberately before emitting it."
            )

    for setting in settings:
        minimum = setting.get("minVersion", 0)
        maximum = setting.get("maxVersion")
        if not isinstance(minimum, int) or minimum < 0:
            problems.append(f"{setting['name']}: bad minVersion {minimum!r}")
        if maximum is not None and maximum < minimum:
            problems.append(
                f"{setting['name']}: maxVersion {maximum} is below minVersion {minimum}"
            )

    # The settings this decoder exists for must not be gated behind a version the fleet does
    # not have; if one becomes gated, that is a finding to look at, not a silent omission.
    for name in ("BulkChargeI", "AbsorbChargeI", "DetailedDataLogInterval"):
        setting = next((s for s in settings if s["name"] == name), None)
        if setting is None:
            problems.append(f"{name} missing from the map")
        elif setting.get("minVersion", 0) > 39:
            problems.append(
                f"{name} requires configuration version "
                f"{setting['minVersion']}, above the 39 our inverter reports"
            )

    problems.extend(check_battery_row_order(row_order, settings))
    return problems


def build(assembly_path: Path, allow_other_assembly: bool) -> dict[str, Any]:
    measured = sha256_of(assembly_path)
    if measured != EXPECTED_ASSEMBLY_SHA256 and not allow_other_assembly:
        raise SystemExit(
            f"assembly sha256 {measured} is not the traced build "
            f"({EXPECTED_ASSEMBLY_SHA256}). A different SP LINK may lay the configuration "
            "blocks out differently. Pass --allow-other-assembly to override, and expect "
            "the self-checks to tell you whether it worked."
        )

    asm = Assembly(assembly_path)
    blocks = extract_blocks(asm)
    if blocks != BLOCKS:
        message = (
            "the five configuration reads in this assembly differ from the expected layout:\n"
            f"  expected {BLOCKS}\n  found    {blocks}"
        )
        if not allow_other_assembly:
            raise SystemExit(message)
        print(f"warning: {message}\nusing the extracted layout.", file=sys.stderr)
    settings = dedupe(extract_settings(asm))
    settings.sort(key=lambda s: (s["block"], s["index"], s["name"]))
    models = extract_models(asm)
    defaults, row_order = extract_default_tables(asm)

    problems = self_check(settings, row_order, merged_words(blocks))
    if problems:
        raise SystemExit(
            "extraction self-checks failed:\n  " + "\n  ".join(problems)
        )

    return {
        "$provenance": {
            "vendorSoftware": VENDOR_SOFTWARE,
            "assemblySha256": measured,
            "installerSha256": INSTALLER_SHA256,
            "method": (
                "Offline .NET IL inspection; vendor executable not run. Setting -> word "
                "index recovered from mConfig.subLoadArrayToSettings_{Common,AppType,"
                "BattType,SystemScheduler} by anchoring on each mConfig.subUpdate*Setting "
                "call and the control setter that follows it. Block addresses and lengths "
                "from mConfig.DownloadOneInvertersConfig, whose length argument is "
                "NumOfAddressLocationsToReadMinusOne. Cross-checked against "
                "DefaultSettingsTemplate.BatterySettingDefaults row order and against "
                "0xc000 + 54 == 0xc036. Version applicability from the enclosing "
                "blt.un/bge.un guard on InverterConfigurationSettingsVersionNumber. "
                "No vendor binaries redistributed."
            ),
            "versionModel": (
                "Per setting, not global. The vendor gates settings on the "
                "configuration-settings version to say a feature did not exist yet, never to "
                "move a word: `if version >= 15 then ... Get(0, 44)`. Each setting therefore "
                "carries minVersion (and maxVersion for the rare legacy-only span), and a "
                "device decodes exactly the settings its version has."
            ),
            "note": (
                "Setting -> word index tables only. These are interoperability facts needed "
                "to read our own inverter's configuration; no vendor binaries or decompiled "
                "source are included. See NOTICE.md."
            ),
            "factoryDefaults": (
                "Columns are battery-type and application-type presets, NOT inverter "
                "models, and these are the vendor's values for a fresh install rather than "
                "this device's. A difference from them is not a fault."
            ),
        },
        "blocks": blocks,
        "commonPart1Words": next(b["words"] for b in blocks if b["name"] == "common"),
        "commonMergedWords": merged_words(blocks)["common"],
        "models": models,
        "settings": settings,
        "factoryDefaults": defaults,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--assembly", required=True, type=Path, help="path to the SP LINK managed assembly"
    )
    parser.add_argument(
        "--allow-other-assembly",
        action="store_true",
        help="proceed even if the assembly is not the traced build",
    )
    args = parser.parse_args()

    document = build(args.assembly, args.allow_other_assembly)
    json.dump(document, sys.stdout, indent=2, sort_keys=False)
    sys.stdout.write("\n")
    print(
        f"extracted {len(document['settings'])} settings, "
        f"{len(document['models'])} models",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
