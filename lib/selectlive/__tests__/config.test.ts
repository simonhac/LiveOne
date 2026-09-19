import {
  CONFIG_DECODER_VERSION,
  decodeConfig,
  readConfig,
  sameRawConfig,
} from "../config";
import {
  appliesAtVersion,
  CONFIG_SETTINGS,
  COMMON_MERGED_WORDS,
  COMMON_PART1_WORDS,
  configAddressOf,
  modelProfile,
} from "../config-map";
import { CONVERTERS } from "../config-converters";
import { SelectLiveError } from "../errors";
import type { DeviceInfo, MemoryReader } from "../protocol";

/** SPMC482: 24 cells, 48 V nominal — the Daylesford inverter. */
const device: DeviceInfo = {
  serial: "221452",
  modelCode: 0,
  firmware: "12.25",
  firmwareRaw: 1225,
  versions: {
    configuration: 51,
    service: 15,
    memoryMap: 33,
    events: 3,
    detailed: 3,
    daily: 5,
  },
};

const BLOCKS: Record<number, number> = {
  0xc000: 197,
  0xc0e5: 18,
  0xc100: 125,
  0xc180: 60,
  0xc800: 193,
};

/** A reader whose every word is zero unless `values` names it by absolute address. */
function memory(
  values: Record<number, number> = {},
  options: { fail?: number; log?: Array<[number, number]> } = {},
): MemoryReader {
  return {
    async query(address, words) {
      options.log?.push([address, words]);
      if (options.fail === address)
        throw new SelectLiveError("protocol", "Inverter refused the read.");
      const buffer = Buffer.alloc(words * 2);
      for (let i = 0; i < words; i++)
        buffer.writeUInt16LE(values[address + i] ?? 0, i * 2);
      return buffer;
    },
  };
}

describe("configuration block addressing", () => {
  it("reads exactly the five blocks SP LINK reads, at the vendor's lengths", async () => {
    const log: Array<[number, number]> = [];
    await readConfig(memory({}, { log }));
    // 🛑 The lengths are the regression test for the vendor's minus-one encoding: the IL
    // literals are 196/17/124/59/192, and reading those would truncate every block.
    expect(log).toEqual([
      [0xc000, 197],
      [0xc0e5, 18],
      [0xc100, 125],
      [0xc180, 60],
      [0xc800, 193],
    ]);
  });

  it("puts the detailed log interval at 0xc036, where the rest of the client expects it", () => {
    // The one address in these blocks that is independently documented, in
    // docs/vendors/selectlive-cli.md, and independently read, by history.ts. If this ever
    // disagrees, the block base is wrong and nothing else in the map is trustworthy.
    expect(configAddressOf("common", 54)).toBe(0xc036);
  });

  it("addresses the common block across its two non-adjacent reads", () => {
    expect(configAddressOf("common", 0)).toBe(0xc000);
    expect(configAddressOf("common", COMMON_PART1_WORDS - 1)).toBe(0xc0c4);
    expect(configAddressOf("common", COMMON_PART1_WORDS)).toBe(0xc0e5);
    expect(configAddressOf("common", COMMON_MERGED_WORDS - 1)).toBe(0xc0f6);
    expect(() => configAddressOf("common", COMMON_MERGED_WORDS)).toThrow();
  });

  it("refuses an index past the end of a block", () => {
    expect(() => configAddressOf("battery", 60)).toThrow();
    expect(() => configAddressOf("battery", -1)).toThrow();
  });
});

describe("reading", () => {
  it("records a failed block without abandoning the others", async () => {
    const raw = await readConfig(memory({}, { fail: 0xc100 }));
    const failed = raw.blocks.find((b) => b.block === "application")!;
    expect(failed.error).toBeDefined();
    expect(failed.hex).toBe("");
    expect(raw.blocks.filter((b) => !b.error)).toHaveLength(4);
  });

  it("detects a configuration that changed between two reads", async () => {
    const before = await readConfig(memory({ 0xc18b: 100 }));
    expect(
      sameRawConfig(before, await readConfig(memory({ 0xc18b: 100 }))),
    ).toBe(true);
    expect(
      sameRawConfig(before, await readConfig(memory({ 0xc18b: 120 }))),
    ).toBe(false);
  });
});

describe("decoding the charge settings", () => {
  const charge = async (values: Record<number, number>, info = device) =>
    decodeConfig(await readConfig(memory(values)), info);
  const get = (snapshot: Awaited<ReturnType<typeof charge>>, name: string) =>
    snapshot.settings.find((s) => s.name === name)!;

  it("reads bulk and absorb charge current straight from their words", async () => {
    const snapshot = await charge({ 0xc18b: 100, 0xc18e: 60 });
    expect(get(snapshot, "BulkChargeI")).toMatchObject({
      block: "battery",
      index: [11],
      address: [0xc18b],
      raw: [100],
      value: 100,
      status: "decoded",
    });
    expect(get(snapshot, "AbsorbChargeI").value).toBe(60);
  });

  it("scales battery voltages by the model's cell count", async () => {
    // 2400 x 24 cells / 1000 = 57.6 V on a 48 V SPMC482.
    const snapshot = await charge({ 0xc18a: 2400 });
    expect(get(snapshot, "BulkChargeV")).toMatchObject({
      value: 57.6,
      unit: "V",
    });
  });

  it("halves that on a 24 V model, rather than reporting the 48 V figure", async () => {
    const spmc241 = { ...device, modelCode: 2 };
    expect(modelProfile(2)?.batteryCells).toBe(12);
    const snapshot = await charge({ 0xc18a: 2400 }, spmc241);
    expect(get(snapshot, "BulkChargeV").value).toBe(28.8);
  });

  it("refuses a DC voltage rather than guessing when the model is unknown", async () => {
    const unknown = { ...device, modelCode: 999 };
    const snapshot = await charge({ 0xc18a: 2400, 0xc18b: 100 }, unknown);
    expect(get(snapshot, "BulkChargeV")).toMatchObject({
      value: null,
      status: "unknown_model",
      raw: [2400],
    });
    // A model-independent setting in the same block still decodes.
    expect(get(snapshot, "BulkChargeI").value).toBe(100);
  });

  it("reports the configured maximum charge capability in deci-units", async () => {
    const snapshot = await charge({ 0xc186: 125 });
    expect(get(snapshot, "MaximumChargeCapability").value).toBe(12.5);
  });
});

describe("refusals and gaps", () => {
  it("gates settings individually by version, not by refusing the whole device", async () => {
    // 🛑 The regression this replaces: a single global floor, set to the highest version gate
    // found anywhere (45), refused to decode ANY setting on our own inverter, which reports
    // 39 — including the charge settings, which are not gated at all.
    const old = {
      ...device,
      versions: { ...device.versions, configuration: 39 },
    };
    const snapshot = decodeConfig(
      await readConfig(memory({ 0xc18b: 100 })),
      old,
    );

    const bulk = snapshot.settings.find((s) => s.name === "BulkChargeI")!;
    expect(bulk.minVersion).toBe(0);
    expect(bulk).toMatchObject({ value: 100, status: "decoded" });
    expect(snapshot.coverage.decoded).toBeGreaterThan(0);

    // A setting the vendor introduced later is absent, not wrong.
    const newer = snapshot.settings.filter((s) => s.minVersion > 39);
    expect(newer.length).toBeGreaterThan(0);
    for (const setting of newer) {
      expect(setting.status).toBe("not_at_this_version");
      expect(setting.value).toBeNull();
    }
  });

  it("decodes strictly more settings on a newer inverter than an older one", async () => {
    const raw = await readConfig(memory());
    const at = (version: number) =>
      decodeConfig(raw, {
        ...device,
        versions: { ...device.versions, configuration: version },
      }).coverage.decoded;
    expect(at(51)).toBeGreaterThan(at(39));
    expect(at(39)).toBeGreaterThan(at(14));
  });

  it("applies a version gate the way the vendor's IL does", () => {
    // `if version >= 15 then nudMaxDaysBetweenPeriodicRecharge = Get(0, 44)`.
    const gated = CONFIG_SETTINGS.find(
      (s) => s.name === "MaxDaysBetweenPeriodicRecharge",
    )!;
    expect(gated.minVersion).toBe(15);
    expect(appliesAtVersion(gated, 14)).toBe(false);
    expect(appliesAtVersion(gated, 15)).toBe(true);
  });

  it("never reports a number for a phase a single inverter does not answer for", async () => {
    const snapshot = decodeConfig(await readConfig(memory()), device);
    const other = snapshot.settings.filter((s) => s.phase !== 0);
    expect(other.length).toBeGreaterThan(0);
    for (const setting of other) {
      expect(setting.status).toBe("phase_not_read");
      expect(setting.value).toBeNull();
    }
  });

  it("keeps raw words for a setting whose converter is not implemented", async () => {
    const snapshot = decodeConfig(
      await readConfig(memory({ [0xc180 + 21]: 7 })),
      device,
    );
    const pending = snapshot.settings.filter(
      (s) => s.status === "converter_not_implemented",
    );
    expect(pending.length).toBeGreaterThan(0);
    for (const setting of pending)
      expect(setting.raw).toHaveLength(setting.index.length);
  });

  it("marks settings in a block that failed to read, rather than decoding zeros", async () => {
    const snapshot = decodeConfig(
      await readConfig(memory({}, { fail: 0xc180 })),
      device,
    );
    const battery = snapshot.settings.filter((s) => s.block === "battery");
    expect(battery.length).toBeGreaterThan(0);
    for (const setting of battery)
      expect(setting.status).toBe("block_not_read");
  });

  it("accounts for every word it read", async () => {
    const snapshot = decodeConfig(await readConfig(memory()), device);
    expect(snapshot.coverage.readWords).toBe(197 + 18 + 125 + 60 + 193);
    expect(snapshot.decoderVersion).toBe(CONFIG_DECODER_VERSION);
    // Mapped words plus unmapped words cannot exceed what was actually read.
    const addressable = COMMON_MERGED_WORDS + 125 + 60 + 193;
    expect(snapshot.unmapped.length).toBeLessThan(addressable);
    expect(snapshot.unmapped.every((w) => Number.isInteger(w.address))).toBe(
      true,
    );
  });
});

describe("enum and multi-word converters", () => {
  const ctx = { batteryCells: 24 };

  it("names combo-box settings from the vendor's own tables", () => {
    expect(CONVERTERS.BatteryTypeSetting.decode([2], ctx)).toBe(
      "Lithium LiFePO4",
    );
    expect(CONVERTERS.ShuntNameSetting.decode([1], ctx)).toBe("Solar");
    expect(CONVERTERS.GeneratorAvailableSetting.decode([0], ctx)).toBe(
      "Assume Always",
    );
    expect(CONVERTERS.ChargerLockoutSetting.decode([2], ctx)).toBe(
      "Charging Off",
    );
  });

  it("lets a traced converter beat a generic table", () => {
    // Both exist for the logging interval. The number is what a consumer can compare.
    expect(CONVERTERS.DataLogIntervalSetting.decode([15], ctx)).toBe(15);
    expect(CONVERTERS.DataLogIntervalSetting.unit).toBe("min");
  });

  it("zeroes a 0xffff high word rather than reading it as disabled", () => {
    // 🛑 The vendor sets the high word to 0 and combines. Treating 0xffff as a disable
    // sentinel turns this inverter's 6.00 kW generator-start threshold into "no threshold",
    // which is the opposite of what it does.
    expect(
      CONVERTERS.AverageBatteryToStartGeneratorSetting.decode(
        [6000, 0xffff],
        ctx,
      ),
    ).toBe(6);
    expect(
      CONVERTERS.AverageBatteryToStartGeneratorSetting.decode([7000, 0], ctx),
    ).toBe(7);
    expect(CONVERTERS.AverageBatteryToStartGeneratorSetting.words).toBe(2);
  });
});

describe("evidence and identity", () => {
  it("masks the model word before looking it up", async () => {
    // 🛑 The low byte is the model; SP LINK applies `And 255` before indexing the same table.
    // Without the mask an inverter setting any upper bit reports `unknown_model`, and all 24
    // DC-voltage settings go blank even though the low byte identified it perfectly.
    expect(modelProfile(0x0100)?.model).toBe("SPMC482");
    expect(modelProfile(0xff00 | 2)?.batteryCells).toBe(12);
    const snapshot = decodeConfig(await readConfig(memory({ 0xc18a: 2400 })), {
      ...device,
      modelCode: 0x0100,
    });
    expect(snapshot.settings.find((s) => s.name === "BulkChargeV")!.value).toBe(
      57.6,
    );
  });

  it("attaches no raw words to a phase that was never read", async () => {
    // 🛑 Every phase 1-3 spec reuses the same word index, so reading the block would hand a
    // multi-phase row the CONNECTED inverter's phase-0 word and present it as that phase's
    // evidence — `Shunt1Name_L2` used to carry `raw: [1]` from a phase nothing was read for.
    const snapshot = decodeConfig(
      await readConfig(memory({ 0xc109: 1 })),
      device,
    );
    const other = snapshot.settings.filter((s) => s.phase !== 0);
    expect(other.length).toBeGreaterThan(0);
    for (const setting of other) {
      expect(setting.status).toBe("phase_not_read");
      expect(setting.raw).toEqual([]);
    }
    // The phase-0 setting sharing that word still reports it.
    const phase0 = snapshot.settings.find(
      (s) => s.phase === 0 && s.address[0] === 0xc109,
    );
    expect(phase0?.raw).toEqual([1]);
  });
});

describe("converters", () => {
  const ctx = { batteryCells: 24 };
  it("applies the vendor's arithmetic exactly", () => {
    expect(CONVERTERS.NumericalSetting.decode([42], ctx)).toBe(42);
    expect(
      CONVERTERS.NumericalSettingWhichIsStoredInDeciUnits.decode([125], ctx),
    ).toBe(12.5);
    expect(
      CONVERTERS.NumericalSettingWhichIsStoredInCentiUnits.decode([1234], ctx),
    ).toBe(12.34);
    expect(
      CONVERTERS.NumericalSettingInUnitsWhichIsStoredInMiliUnits.decode(
        [1500],
        ctx,
      ),
    ).toBe(1.5);
    expect(
      CONVERTERS.NumericalSettingWithOffSetOf10000.decode([10250], ctx),
    ).toBe(250);
    expect(CONVERTERS.NumericalSettingAndChangeSign.decode([250], ctx)).toBe(
      -250,
    );
    expect(CONVERTERS.CTRatioSetting.decode([20], ctx)).toBe(100);
    expect(
      CONVERTERS.NumericalSetting_TemperatureCoefficient.decode([9500], ctx),
    ).toBe(-0.5);
  });

  it("rounds before subtracting for the offset-100 form, as the vendor does", () => {
    // 🛑 Not (raw - 1000) / 10: SP LINK rounds to one place first, then subtracts 100.
    expect(
      CONVERTERS.NumericalSettingWhichIsStoredInDeciUnitsOffset100.decode(
        [1005],
        ctx,
      ),
    ).toBe(0.5);
  });

  it("rounds midpoints the way the vendor does, not the way toFixed does", () => {
    // 🛑 `RealRound` adds a signed half-unit and truncates, in decimal. `toFixed` rounds a
    // binary double and sees 1.005 as 1.00499…, so it yields 1.00 where SP LINK yields 1.01.
    // Differing from the vendor in the last digit is what later looks like a changed setting.
    expect((1005 / 1000).toFixed(2)).toBe("1.00");
    expect(
      CONVERTERS.NumericalSettingInUnitsWhichIsStoredInMiliUnits.decode(
        [1005],
        ctx,
      ),
    ).toBe(1.01);
    expect(
      CONVERTERS.NumericalSettingWhichIsStoredInDeciUnits.decode([125], ctx),
    ).toBe(12.5);
  });

  it("rounds negatives away from zero, as a signed half-unit does", () => {
    expect(
      CONVERTERS.NumericalSetting_TemperatureCoefficient.decode([9500], ctx),
    ).toBe(-0.5);
    expect(
      CONVERTERS.NumericalSettingWhichIsStoredInDeciUnitsAndChangeSign.decode(
        [125],
        ctx,
      ),
    ).toBe(-12.5);
  });

  it("renders times as minutes from midnight", () => {
    expect(CONVERTERS.TimeSetting.decode([0], ctx)).toBe("00:00");
    expect(CONVERTERS.TimeSetting.decode([1439], ctx)).toBe("23:59");
    expect(CONVERTERS.TimeSetting.decode([450], ctx)).toBe("07:30");
  });

  it("treats 1440 as disabled only where the vendor offers that, and only exactly", () => {
    expect(CONVERTERS.StopTimeWithDisableSetting.decode([1440], ctx)).toBe(
      "Disabled",
    );
    expect(CONVERTERS.StopTimeWithDisableSetting.decode([60], ctx)).toBe(
      "01:00",
    );
    expect(CONVERTERS.StopTimeWithoutDisableSetting.decode([60], ctx)).toBe(
      "01:00",
    );
    // 🛑 Above a full day the vendor takes its error path. Reporting 1500 as "Disabled" would
    // be a specific, plausible and false claim about a corrupt or future word.
    expect(CONVERTERS.StopTimeWithDisableSetting.decode([1500], ctx)).toBe(
      "UNDECODED(1500)",
    );
    // The form with no disabled state rejects the boundary itself.
    expect(CONVERTERS.StopTimeWithoutDisableSetting.decode([1440], ctx)).toBe(
      "UNDECODED(1440)",
    );
    // 1500 minutes is not 25:00.
    expect(CONVERTERS.TimeSetting.decode([1500], ctx)).toBe("UNDECODED(1500)");
  });

  it("labels an out-of-range enum rather than inventing a meaning", () => {
    expect(CONVERTERS.LogicalSetting.decode([0], ctx)).toBe("Disabled");
    expect(CONVERTERS.LogicalSetting.decode([1], ctx)).toBe("Enabled");
    expect(CONVERTERS.LogicalSetting.decode([7], ctx)).toBe("UNDECODED(7)");
    expect(CONVERTERS.DataLogIntervalSetting.decode([15], ctx)).toBe(15);
    expect(CONVERTERS.DataLogIntervalSetting.decode([3], ctx)).toBe(
      "UNDECODED(3)",
    );
  });
});
