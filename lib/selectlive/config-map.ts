/**
 * The SP PRO's configuration field map: which word of which block holds which setting.
 *
 * Selectronic publishes no register map for the configuration blocks, so without this table a
 * downloaded configuration is 593 anonymous 16-bit words. It was recovered by offline IL
 * inspection of SP LINK 16.11.9663 — the same assembly, and the same method, that produced
 * `event-labels.json`. The provenance travels with the table itself, in `config-map.json`; the
 * extractor is `tools/splink/extract_config_map.py`. No vendor binaries or decompiled source are
 * in this repository — see NOTICE.md.
 *
 * 🛑 A word with no setting, or a setting whose converter is not implemented, is reported with its
 * raw value and an explicit status. It is never guessed at and never dropped — the same discipline
 * as `UNDECODED(n)` in `event-labels.ts`. A confident wrong value in a stored manifest is worse
 * than an honest gap, because it will be read a year later during an incident.
 */
import map from "./config-map.json";

/** Blocks as SP LINK reads them. `commonPart2` is merged into `common` before decoding. */
export type ConfigBlockName =
  | "common"
  | "application"
  | "battery"
  | "scheduler";

export interface ConfigBlockSpec {
  name: ConfigBlockName | "commonPart2";
  address: number;
  words: number;
  /** SP LINK's own tag for the read, retained as an evidence trail. */
  splinkSection: number;
}

export interface ConfigSettingSpec {
  /** SP LINK's canonical name, e.g. `BulkChargeI`. */
  name: string;
  /** The widget it fills, e.g. `nudBulkChargeI`. Kept as the trail back to the IL. */
  control: string;
  block: ConfigBlockName;
  /**
   * The multi-phase phase this setting is read for. A single-inverter download populates
   * phase 0 only; anything above it is reported as not read rather than decoded from zeros.
   */
  phase: number;
  /** Word index within the block. More than one for settings spanning two words. */
  index: number[];
  /** Vendor converter name, minus the `mConfig.subUpdate` prefix and `Setting` suffix. */
  converter: string;
  /** Lowest configuration-settings version at which this setting exists. 0 = always. */
  minVersion: number;
  /** Highest version, for the one setting the vendor retired. Usually absent. */
  maxVersion?: number;
}

export interface ConfigModelSpec {
  model: string;
  /** Series cell count. `subUpdateDCVoltageSetting` is `raw x batteryCells / 1000`. */
  batteryCells: number;
  nominalBatteryVoltage: number;
}

export interface ConfigMapProvenance {
  vendorSoftware: string;
  assemblySha256: string;
  installerSha256: string;
  method: string;
  versionModel: string;
  note: string;
  factoryDefaults: string;
}

interface ConfigMapFile {
  $provenance: ConfigMapProvenance;
  blocks: ConfigBlockSpec[];
  commonPart1Words: number;
  commonMergedWords: number;
  models: Record<string, ConfigModelSpec>;
  settings: ConfigSettingSpec[];
  enums: Record<string, Record<string, string>>;
  factoryDefaults: Record<string, Record<string, string[]>>;
}

const FILE = map as unknown as ConfigMapFile;

export const configMapProvenance: ConfigMapProvenance = FILE.$provenance;
export const CONFIG_BLOCKS: readonly ConfigBlockSpec[] = FILE.blocks;
export const CONFIG_SETTINGS: readonly ConfigSettingSpec[] = FILE.settings;

/** Words of `common` that come from part 1; the rest come from part 2 at `0xc0e5`. */
export const COMMON_PART1_WORDS = FILE.commonPart1Words;
/** Total addressable words of the merged `common` block. */
export const COMMON_MERGED_WORDS = FILE.commonMergedWords;

/**
 * Whether a setting exists on an inverter reporting this configuration-settings version.
 *
 * 🛑 Version gates in the vendor's decoders are FEATURE AVAILABILITY, not a different layout.
 * They read `if version >= 15 then ... Get(0, 44)`: word 44 means the same thing at every
 * version, it simply did not exist before 15. So there is no global floor to clear — a setting
 * either applies to this device or it does not, and everything else decodes normally.
 *
 * An earlier version of this file carried a single floor set to the highest gate found anywhere
 * (45). That refused to decode ANY setting on our own inverter, which reports 39, including the
 * charge settings that are not gated at all.
 */
export function appliesAtVersion(
  setting: Pick<ConfigSettingSpec, "minVersion" | "maxVersion">,
  version: number,
): boolean {
  if (version < setting.minVersion) return false;
  return setting.maxVersion === undefined || version <= setting.maxVersion;
}

/** Words the merged block holds, for bounds checks. */
export function blockWords(block: ConfigBlockName): number {
  if (block === "common") return COMMON_MERGED_WORDS;
  const spec = CONFIG_BLOCKS.find((b) => b.name === block);
  if (!spec) throw new Error(`unknown configuration block: ${block}`);
  return spec.words;
}

/**
 * The absolute word address of a block index.
 *
 * 🛑 `common` is not contiguous. SP LINK reads 197 words at `0xc000` and 18 more at `0xc0e5`,
 * then concatenates them, so merged indices 197..214 live 32 words further up than a naive
 * `base + index` would put them. The gap between the two is deliberately never read.
 */
export function configAddressOf(block: ConfigBlockName, index: number): number {
  const limit = blockWords(block);
  if (!Number.isInteger(index) || index < 0 || index >= limit)
    throw new Error(
      `${block} word ${index} is outside the ${limit} words read`,
    );
  if (block !== "common") {
    const spec = CONFIG_BLOCKS.find((b) => b.name === block)!;
    return spec.address + index;
  }
  const part1 = CONFIG_BLOCKS.find((b) => b.name === "common")!;
  const part2 = CONFIG_BLOCKS.find((b) => b.name === "commonPart2")!;
  return index < COMMON_PART1_WORDS
    ? part1.address + index
    : part2.address + (index - COMMON_PART1_WORDS);
}

/**
 * Code -> label tables for the combo-box settings, keyed by vendor converter name.
 *
 * Same shape and same provenance as `event-labels.json`: each is the `switch` a vendor converter
 * selects its display string from, read out of the assembly rather than guessed. Without them
 * `BatteryType` is the integer 2 rather than "Lithium LiFePO4".
 */
export const CONFIG_ENUMS: Readonly<Record<string, Record<string, string>>> =
  FILE.enums;

/** Every converter that has a table, for building the enum decoders. */
export const enumConverterNames = (): string[] => Object.keys(FILE.enums);

/**
 * The label for a code, or `UNDECODED(n)`.
 *
 * 🛑 Never guessed and never dropped, exactly as in `event-labels.ts`: a code the vendor has no
 * entry for is one we cannot name, and saying so is more useful than omitting the row.
 */
export function enumLabel(converter: string, code: number): string {
  return CONFIG_ENUMS[converter]?.[String(code)] ?? `UNDECODED(${code})`;
}

/**
 * Model identity and battery cell count for a model word, or null if the code is unknown.
 *
 * 🛑 The low byte is the model; the upper bits are something else. SP LINK's
 * `fnConvertInverterModelValueToModelNumberString` applies `value And 255` before indexing this
 * same table, and then bounds-checks the result. Matching the word exactly would return null on
 * any inverter that sets an upper bit, and every DC-voltage setting would silently become
 * `unknown_model` even though the low byte identified the model perfectly well.
 */
export function modelProfile(modelCode: number): ConfigModelSpec | null {
  return FILE.models[String(modelCode & 0xff)] ?? null;
}

/**
 * Vendor factory defaults for a setting, or null.
 *
 * 🛑 Advisory only, and NOT this device's values. The columns are battery-type and
 * application-type presets rather than inverter models, so a default is only meaningful once the
 * configured type is known — which is why nothing here computes a "differs from default" flag.
 */
export function factoryDefaults(name: string): string[] | null {
  for (const table of Object.values(FILE.factoryDefaults)) {
    const row = table[name];
    if (row) return row;
  }
  return null;
}
