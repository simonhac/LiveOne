/**
 * Preserving a configuration snapshot to disk.
 *
 * The point of a snapshot is to be readable in a year, during an incident, by somebody who has
 * to tell whether a setting changed or the decoder did. So the raw words and their provenance are
 * written before anything is interpreted, and every setting that could not be decoded says so
 * explicitly rather than being omitted.
 *
 * 🛑 This is a record for inspection, NOT a restore file. Nothing here writes to the inverter and
 * nothing here produces something SP LINK could import.
 */
import fs from "node:fs";
import path from "node:path";

import {
  CONFIG_DECODER_VERSION,
  decodeConfig,
  readConfig,
  sameRawConfig,
  type ConfigSnapshot,
  type RawConfigBlock,
} from "./config";
import { configMapProvenance, type ConfigMapProvenance } from "./config-map";
import { SelectLiveError } from "./errors";
import type { DeviceInfo, MemoryReader } from "./protocol";

export interface ConfigDownloadOptions {
  out: string;
  signal?: AbortSignal;
}

type ConfigDecodingState =
  | "pending"
  | "decoded"
  | "partial"
  | "not_attempted_unstable"
  | "failed";

/**
 * What the second read of every block established.
 *
 * 🛑 Three outcomes, not two. `readConfig` records a failed block rather than throwing, so a
 * transient error on the verification pass makes the two reads differ — and calling that
 * `changed` would assert a configuration change on no evidence at all, which is exactly the
 * claim somebody would act on. An unverified capture is still a capture.
 */
type ConfigVerification = "stable" | "changed" | "unverified";

export interface ConfigManifest {
  version: number;
  directory: string;
  device: DeviceInfo;
  startedAt: string;
  finishedAt?: string;
  decoderVersion: number;
  mapProvenance: ConfigMapProvenance;
  blocks: RawConfigBlock[];
  rawSha256: string | null;
  /** What a second read of every block established. */
  verification: ConfigVerification;
  /** Whether every block read without error. */
  complete: boolean;
  decoding: ConfigDecodingState;
  coverage: ConfigSnapshot["coverage"] | null;
  error?: string;
}

const CONFIG_CSV_COLUMNS = [
  "name",
  "control",
  "block",
  "index",
  "address_hex",
  "raw_words",
  "value",
  "unit",
  "converter",
  "status",
  "factory_defaults",
] as const;

const csvCell = (value: unknown): string => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

function writeCsv(
  file: string,
  header: readonly string[],
  rows: unknown[][],
): void {
  const body = [
    header.join(","),
    ...rows.map((row) => row.map(csvCell).join(",")),
  ];
  fs.writeFileSync(file, body.join("\n") + "\n", { mode: 0o600 });
}

export function validateConfigDownloadOptions(
  options: ConfigDownloadOptions,
): void {
  if (!options.out.trim())
    throw new SelectLiveError("usage", "--out must name a directory.");
}

export async function downloadConfig(
  reader: MemoryReader,
  device: DeviceInfo,
  options: ConfigDownloadOptions,
): Promise<ConfigManifest> {
  validateConfigDownloadOptions(options);
  fs.mkdirSync(options.out, { recursive: true });
  const directory = fs.mkdtempSync(
    path.join(path.resolve(options.out), `selectlive-config-${device.serial}-`),
  );

  const manifest: ConfigManifest = {
    version: 1,
    directory,
    device,
    startedAt: new Date().toISOString(),
    decoderVersion: CONFIG_DECODER_VERSION,
    mapProvenance: configMapProvenance,
    blocks: [],
    rawSha256: null,
    verification: "unverified",
    complete: false,
    decoding: "pending",
    coverage: null,
  };
  const manifestPath = path.join(directory, "manifest.json");
  const writeManifest = () => {
    fs.writeFileSync(
      `${manifestPath}.tmp`,
      JSON.stringify(manifest, null, 2) + "\n",
      {
        mode: 0o600,
      },
    );
    fs.renameSync(`${manifestPath}.tmp`, manifestPath);
  };
  writeManifest();

  try {
    const raw = await readConfig(reader, { signal: options.signal });
    manifest.blocks = raw.blocks;
    manifest.rawSha256 = raw.sha256;
    manifest.complete = raw.blocks.every((block) => !block.error);

    // Raw evidence lands before anything is interpreted, so a decoder that throws below still
    // leaves a usable capture behind.
    fs.writeFileSync(
      path.join(directory, "blocks.jsonl"),
      raw.blocks.map((block) => JSON.stringify(block)).join("\n") + "\n",
      { mode: 0o600 },
    );
    writeManifest();

    // 🛑 Read everything a second time and compare. Configuration should not change while it is
    // being read; if it did, the five blocks are a mix of two states and decoding them would
    // produce a snapshot that never existed on the device.
    const second = await readConfig(reader, { signal: options.signal });
    const verified = second.blocks.every((block) => !block.error);
    manifest.verification = !verified
      ? "unverified"
      : sameRawConfig(raw, second)
        ? "stable"
        : "changed";
    writeManifest();

    // A changed or incomplete capture is not decoded; an unverified one still is, because the
    // first read succeeded in full and refusing it would discard good evidence over a failure
    // that says nothing about the data.
    if (manifest.verification === "changed" || !manifest.complete) {
      manifest.decoding = "not_attempted_unstable";
      manifest.finishedAt = new Date().toISOString();
      writeManifest();
      return manifest;
    }

    const snapshot = decodeConfig(raw, device);
    manifest.coverage = snapshot.coverage;
    manifest.decoding = snapshot.coverage.undecoded > 0 ? "partial" : "decoded";

    fs.writeFileSync(
      path.join(directory, "settings.json"),
      JSON.stringify(snapshot, null, 2) + "\n",
      { mode: 0o600 },
    );
    writeCsv(
      path.join(directory, "settings.csv"),
      CONFIG_CSV_COLUMNS,
      snapshot.settings.map((setting) => [
        setting.name,
        setting.control,
        setting.block,
        setting.index.join(" "),
        setting.address.map((a) => `0x${a.toString(16)}`).join(" "),
        setting.raw.join(" "),
        setting.value,
        setting.unit ?? "",
        setting.converter,
        setting.status,
        setting.factoryDefaults?.join(" ") ?? "",
      ]),
    );
    // Words that were read but belong to no setting. Without this, "we read 593 words and
    // named 421" is an inference rather than something the capture states.
    writeCsv(
      path.join(directory, "unmapped.csv"),
      ["block", "index", "address_hex", "raw"],
      snapshot.unmapped.map((word) => [
        word.block,
        word.index,
        `0x${word.address.toString(16)}`,
        word.raw,
      ]),
    );
  } catch (error) {
    manifest.decoding = "failed";
    manifest.error =
      error instanceof SelectLiveError
        ? error.message
        : "Configuration download failed.";
    if (error instanceof SelectLiveError && error.kind === "interrupted") {
      manifest.finishedAt = new Date().toISOString();
      writeManifest();
      throw error;
    }
  }

  manifest.finishedAt = new Date().toISOString();
  writeManifest();
  return manifest;
}
