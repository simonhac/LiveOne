/**
 * Reading the SP PRO's stored configuration.
 *
 * SP LINK populates its configuration tabs from five ordinary reads of the inverter's memory —
 * the same `Q` reads this client already uses for identity and the logs, with no passcode and no
 * write of any kind. `lib/selectlive/config-map.json` says which word means what.
 *
 * Why this exists: the charge settings are the difference between "the battery was charged hard"
 * and "the charger was configured to charge that hard", and until now the only way to see them
 * was to open SP LINK on a laptop. Shunt assignments, the logging interval and the generator
 * thresholds are likewise the context every stored reading needs to be interpretable later.
 *
 * 🛑 Read-only, and it must stay that way. The only write this client performs anywhere is the
 * authentication challenge in `protocol.ts`; `scripts/selectlive/__tests__/cli.test.ts` asserts
 * that, and it is the test that keeps the claim in `docs/vendors/selectlive-cli.md` honest.
 */
import { createHash } from "node:crypto";

import {
  appliesAtVersion,
  CONFIG_BLOCKS,
  CONFIG_SETTINGS,
  COMMON_PART1_WORDS,
  configAddressOf,
  configMapProvenance,
  factoryDefaults,
  modelProfile,
  blockWords,
  type ConfigBlockName,
  type ConfigMapProvenance,
  type ConfigModelSpec,
} from "./config-map";
import { CONVERTERS } from "./config-converters";
import { SelectLiveError } from "./errors";
import { wordsFrom, type DeviceInfo, type MemoryReader } from "./protocol";

/**
 * Bump when a decoded value's meaning or scaling changes. Stored with every capture, so that a
 * later disagreement between two snapshots can be attributed to the decoder rather than to
 * somebody having changed a setting.
 */
export const CONFIG_DECODER_VERSION = 1;

export interface RawConfigBlock {
  block: string;
  address: number;
  words: number;
  /** Raw little-endian words as read, preserved before any decoding is attempted. */
  hex: string;
  error?: string;
}

export interface RawConfig {
  blocks: RawConfigBlock[];
  /** SHA-256 over the concatenated raw block bytes, in read order. */
  sha256: string;
}

type SettingStatus =
  | "decoded"
  | "converter_not_implemented"
  | "phase_not_read"
  | "unknown_model"
  | "not_at_this_version"
  | "block_not_read";

export interface DecodedSetting {
  name: string;
  control: string;
  block: ConfigBlockName;
  index: number[];
  address: number[];
  /** Always present, whatever the status. The evidence outlives the decoder. */
  raw: number[];
  phase: number;
  converter: string;
  /** Lowest configuration version this setting exists at; 0 when it always has. */
  minVersion: number;
  value: string | number | null;
  unit?: string;
  status: SettingStatus;
  /** Vendor factory defaults per battery/application type. Advisory; see config-map.ts. */
  factoryDefaults?: string[];
}

interface UnmappedWord {
  block: ConfigBlockName;
  index: number;
  address: number;
  raw: number;
}

export interface ConfigSnapshot {
  decoderVersion: number;
  mapProvenance: ConfigMapProvenance;
  configurationVersion: number;
  modelCode: number;
  model: ConfigModelSpec | null;
  blocks: RawConfigBlock[];
  rawSha256: string;
  settings: DecodedSetting[];
  unmapped: UnmappedWord[];
  coverage: {
    readWords: number;
    settings: number;
    decoded: number;
    undecoded: number;
    unmappedWords: number;
  };
}

/**
 * Read all five configuration blocks.
 *
 * Blocks are read one at a time, in the vendor's order, and a failure on one is recorded against
 * that block rather than abandoning the rest — a partial configuration with an explicit hole is
 * far more useful during an outage than nothing at all.
 *
 * 🛑 The gap between common part 1 (`0xc000`) and part 2 (`0xc0e5`) is deliberately not read.
 * SP LINK does not read it, so those words have no index, no name and no provenance, and reading
 * them would only invite somebody to map them later by correlation.
 */
export async function readConfig(
  reader: MemoryReader,
  options: { signal?: AbortSignal } = {},
): Promise<RawConfig> {
  const blocks: RawConfigBlock[] = [];
  const digest = createHash("sha256");
  for (const spec of CONFIG_BLOCKS) {
    if (options.signal?.aborted)
      throw new SelectLiveError(
        "interrupted",
        "Configuration read interrupted.",
      );
    const entry: RawConfigBlock = {
      block: spec.name,
      address: spec.address,
      words: spec.words,
      hex: "",
    };
    try {
      const bytes = await reader.query(spec.address, spec.words);
      entry.hex = bytes.toString("hex");
      digest.update(bytes);
    } catch (error) {
      entry.error =
        error instanceof SelectLiveError ? error.message : "Block read failed.";
    }
    blocks.push(entry);
  }
  return { blocks, sha256: digest.digest("hex") };
}

/** Whether two reads of the configuration returned identical bytes. */
export const sameRawConfig = (a: RawConfig, b: RawConfig): boolean =>
  a.blocks.length === b.blocks.length &&
  a.blocks.every(
    (block, i) =>
      block.hex === b.blocks[i].hex && block.error === b.blocks[i].error,
  );

/**
 * Merge the five reads into the four indexed blocks the vendor's decoders address.
 *
 * 🛑 `common` is built from two non-adjacent reads: 197 words at `0xc000` followed by 18 at
 * `0xc0e5`. Treating it as one contiguous 215-word range would shift every setting above index
 * 196 by 32 words and report a whole tail of plausible nonsense.
 */
function indexedWords(raw: RawConfig): Map<ConfigBlockName, number[] | null> {
  const byName = new Map(raw.blocks.map((block) => [block.block, block]));
  const read = (name: string): number[] | null => {
    const block = byName.get(name);
    if (!block || block.error || !block.hex) return null;
    return wordsFrom(Buffer.from(block.hex, "hex"));
  };
  const part1 = read("common");
  const part2 = read("commonPart2");
  return new Map<ConfigBlockName, number[] | null>([
    [
      "common",
      part1 && part2 ? [...part1.slice(0, COMMON_PART1_WORDS), ...part2] : null,
    ],
    ["application", read("application")],
    ["battery", read("battery")],
    ["scheduler", read("scheduler")],
  ]);
}

/**
 * Decode a raw configuration into named settings.
 *
 * `device` is required because two things outside the blocks change what the words mean: the
 * model sets the battery cell count every DC-voltage setting is scaled by, and the configuration
 * version decides which settings exist at all.
 *
 * 🛑 Version gating is PER SETTING. The vendor gates a setting to say the feature did not exist
 * yet, never to move a word, so an older inverter decodes everything it does have. A setting the
 * device is too old for reports `not_at_this_version` rather than a number read out of a word
 * that means nothing on it.
 */
export function decodeConfig(
  raw: RawConfig,
  device: DeviceInfo,
): ConfigSnapshot {
  const model = modelProfile(device.modelCode);
  const batteryCells = model?.batteryCells ?? null;
  const version = device.versions.configuration;
  const words = indexedWords(raw);

  const settings: DecodedSetting[] = CONFIG_SETTINGS.map((spec) => {
    const block = words.get(spec.block) ?? null;
    const address = spec.index.map((index) =>
      configAddressOf(spec.block, index),
    );
    // 🛑 Only phase 0 was read. Every phase 1-3 spec reuses the same word index, so reading the
    // block here would hand a multi-phase row the CONNECTED inverter's word and present it as
    // that phase's evidence — `Shunt1Name_L2` carried `raw: [1]` from a phase nothing was ever
    // read for. A row that was not captured must carry no raw value at all.
    const captured = block !== null && spec.phase === 0;
    const rawWords = captured ? spec.index.map((index) => block![index]) : [];
    const converter = CONVERTERS[spec.converter];
    const defaults = factoryDefaults(spec.name);

    const base = {
      name: spec.name,
      control: spec.control,
      block: spec.block,
      index: spec.index,
      address,
      raw: rawWords,
      phase: spec.phase,
      converter: spec.converter,
      minVersion: spec.minVersion,
      unit: converter?.unit,
      ...(defaults ? { factoryDefaults: defaults } : {}),
    };

    const status: SettingStatus | null = !block
      ? "block_not_read"
      : // A single inverter answers for phase 0 only. The other phases' words are never
        // read, so decoding them would report a number derived from nothing.
        spec.phase !== 0
        ? "phase_not_read"
        : !appliesAtVersion(spec, version)
          ? "not_at_this_version"
          : !converter
            ? "converter_not_implemented"
            : null;
    if (status) return { ...base, value: null, status };

    const value = converter!.decode(rawWords, { batteryCells });
    return value === null
      ? { ...base, value: null, status: "unknown_model" as const }
      : { ...base, value, status: "decoded" as const };
  });

  const mapped = new Set(
    CONFIG_SETTINGS.flatMap((spec) =>
      spec.index.map((index) => `${spec.block}:${index}`),
    ),
  );
  const unmapped: UnmappedWord[] = [];
  for (const [block, values] of words) {
    if (!values) continue;
    for (
      let index = 0;
      index < Math.min(values.length, blockWords(block));
      index++
    ) {
      if (mapped.has(`${block}:${index}`)) continue;
      unmapped.push({
        block,
        index,
        address: configAddressOf(block, index),
        raw: values[index],
      });
    }
  }

  const decoded = settings.filter((s) => s.status === "decoded").length;
  return {
    decoderVersion: CONFIG_DECODER_VERSION,
    mapProvenance: configMapProvenance,
    configurationVersion: version,
    modelCode: device.modelCode,
    model,
    blocks: raw.blocks,
    rawSha256: raw.sha256,
    settings,
    unmapped,
    coverage: {
      readWords: raw.blocks.reduce(
        (total, block) => total + (block.error ? 0 : block.words),
        0,
      ),
      settings: settings.length,
      decoded,
      undecoded: settings.length - decoded,
      unmappedWords: unmapped.length,
    },
  };
}
