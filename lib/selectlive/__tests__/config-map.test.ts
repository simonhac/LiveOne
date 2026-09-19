/**
 * Integrity of the generated configuration map.
 *
 * `config-map.json` is produced by `tools/splink/extract_config_map.py` from a vendor assembly
 * that is not in this repository, so nobody reviewing a regeneration can check it by reading the
 * diff. These assertions are what stands in for that review: they are the properties that, if
 * violated, would let a plausible but wrong field map ship.
 */
import labels from "../event-labels.json";
import {
  CONFIG_BLOCKS,
  CONFIG_SETTINGS,
  COMMON_MERGED_WORDS,
  COMMON_PART1_WORDS,
  blockWords,
  configAddressOf,
  configMapProvenance,
  factoryDefaults,
  modelProfile,
} from "../config-map";
import { CONVERTERS, KNOWN_UNIMPLEMENTED } from "../config-converters";

describe("provenance", () => {
  it("was traced from the same assembly as the event labels", () => {
    // Both tables come from one SP LINK build. If they diverge, one was regenerated without
    // the other and the pair can no longer be reasoned about together.
    const events = (labels as { $provenance: { assemblySha256: string } })
      .$provenance;
    expect(configMapProvenance.assemblySha256).toBe(events.assemblySha256);
    expect(configMapProvenance.assemblySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("states that version gating is per setting rather than a global floor", () => {
    expect(configMapProvenance.versionModel).toMatch(/per setting/i);
  });
});

describe("blocks", () => {
  it("describes the five reads, with the merged common block adding up", () => {
    expect(CONFIG_BLOCKS.map((b) => [b.name, b.address, b.words])).toEqual([
      ["common", 0xc000, 197],
      ["commonPart2", 0xc0e5, 18],
      ["application", 0xc100, 125],
      ["battery", 0xc180, 60],
      ["scheduler", 0xc800, 193],
    ]);
    const part1 = CONFIG_BLOCKS.find((b) => b.name === "common")!;
    const part2 = CONFIG_BLOCKS.find((b) => b.name === "commonPart2")!;
    expect(part1.words + part2.words).toBe(COMMON_MERGED_WORDS);
    expect(part1.words).toBe(COMMON_PART1_WORDS);
  });

  it("leaves a gap between the two common reads, which is never addressable", () => {
    const lastOfPart1 = configAddressOf("common", COMMON_PART1_WORDS - 1);
    const firstOfPart2 = configAddressOf("common", COMMON_PART1_WORDS);
    expect(firstOfPart2).toBeGreaterThan(lastOfPart1 + 1);
  });
});

describe("settings", () => {
  it("maps every setting inside the words its block actually reads", () => {
    for (const setting of CONFIG_SETTINGS) {
      const limit = blockWords(setting.block);
      for (const index of setting.index) {
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(limit);
      }
    }
  });

  it("gives each name exactly one home", () => {
    const places = new Map<string, string>();
    for (const setting of CONFIG_SETTINGS) {
      const where = `${setting.block}:${setting.index.join(",")}`;
      const seen = places.get(setting.name);
      if (seen !== undefined)
        expect(`${setting.name} ${where}`).toBe(`${setting.name} ${seen}`);
      places.set(setting.name, where);
    }
    expect(places.size).toBe(CONFIG_SETTINGS.length);
  });

  it("anchors the detailed log interval at the address the rest of the client uses", () => {
    const interval = CONFIG_SETTINGS.filter(
      (s) => s.name === "DetailedDataLogInterval",
    );
    expect(interval).toHaveLength(1);
    expect(interval[0].block).toBe("common");
    expect(configAddressOf("common", interval[0].index[0])).toBe(0xc036);
  });

  it("carries the charge settings this decoder exists for", () => {
    const expected: Array<[string, number]> = [
      ["MaximumChargeCapability", 0xc186],
      ["InitialChargeV", 0xc187],
      ["InitialChargeI", 0xc188],
      ["BulkChargeV", 0xc18a],
      ["BulkChargeI", 0xc18b],
      ["AbsorbChargeV", 0xc18d],
      ["AbsorbChargeI", 0xc18e],
    ];
    for (const [name, address] of expected) {
      const setting = CONFIG_SETTINGS.find((s) => s.name === name);
      expect(setting).toBeDefined();
      expect(configAddressOf(setting!.block, setting!.index[0])).toBe(address);
    }
  });

  it("gates the charge settings at no version at all", () => {
    // These are what the decoder exists for, and our own inverter reports version 39. If one
    // ever becomes gated above that, it should be a visible finding rather than a blank row.
    for (const name of [
      "BulkChargeI",
      "AbsorbChargeI",
      "DetailedDataLogInterval",
    ]) {
      const setting = CONFIG_SETTINGS.find((s) => s.name === name)!;
      expect(setting.minVersion).toBe(0);
    }
  });

  it("gives every setting a sane version window", () => {
    for (const setting of CONFIG_SETTINGS) {
      expect(setting.minVersion).toBeGreaterThanOrEqual(0);
      if (setting.maxVersion !== undefined)
        expect(setting.maxVersion).toBeGreaterThanOrEqual(setting.minVersion);
    }
  });

  it("gates the charge settings at no version at all", () => {
    // These are what the decoder exists for, and our own inverter reports version 39. If one
    // ever becomes gated above that, it should be a visible finding rather than a blank row.
    for (const name of [
      "BulkChargeI",
      "AbsorbChargeI",
      "DetailedDataLogInterval",
    ]) {
      const setting = CONFIG_SETTINGS.find((s) => s.name === name)!;
      expect(setting.minVersion).toBe(0);
    }
  });

  it("gives every setting a sane version window", () => {
    for (const setting of CONFIG_SETTINGS) {
      expect(setting.minVersion).toBeGreaterThanOrEqual(0);
      if (setting.maxVersion !== undefined)
        expect(setting.maxVersion).toBeGreaterThanOrEqual(setting.minVersion);
    }
  });

  it("holds no credential material", () => {
    // 🛑 Nothing in these five blocks did when this was written — SP LINK keeps the passcode
    // elsewhere. This fails if a regeneration introduces one, so that it becomes a decision
    // rather than something quietly written into every future manifest and CSV.
    const sensitive = CONFIG_SETTINGS.filter((s) =>
      /password|passcode|pwd|secret|token|apikey/i.test(s.name),
    );
    expect(sensitive.map((s) => s.name)).toEqual([]);
  });

  it("names a converter that is either implemented or explicitly deferred", () => {
    // Adding a converter should be deliberate; an unrecognised one must not degrade silently
    // into `converter_not_implemented` in every manifest from here on.
    const undecided = [
      ...new Set(CONFIG_SETTINGS.map((s) => s.converter)),
    ].filter(
      (converter) =>
        !CONVERTERS[converter] && !KNOWN_UNIMPLEMENTED.has(converter),
    );
    expect(undecided).toEqual([]);
  });

  it("does not list a converter as deferred while also implementing it", () => {
    expect(
      Object.keys(CONVERTERS).filter((c) => KNOWN_UNIMPLEMENTED.has(c)),
    ).toEqual([]);
  });

  it("consumes as many words as its converter expects", () => {
    for (const setting of CONFIG_SETTINGS) {
      const converter = CONVERTERS[setting.converter];
      if (converter) expect(setting.index).toHaveLength(converter.words);
    }
  });
});

describe("models", () => {
  it("scales battery voltage by a plausible series cell count", () => {
    const codes = CONFIG_SETTINGS.length ? [0, 1, 2, 3, 4, 5, 6, 7, 8] : [];
    for (const code of codes) {
      const model = modelProfile(code);
      expect(model).not.toBeNull();
      expect(model!.model).toMatch(/^SP[ML]C\d+$/);
      // 2 V lead-acid cells: 12 -> 24 V, 24 -> 48 V, 60 -> 120 V.
      expect([12, 24, 60]).toContain(model!.batteryCells);
      expect(model!.nominalBatteryVoltage).toBe(model!.batteryCells * 2);
    }
    expect(modelProfile(0)!.model).toBe("SPMC482");
    expect(modelProfile(999)).toBeNull();
  });
});

describe("factory defaults", () => {
  it("are advisory, and say so", () => {
    expect(configMapProvenance.factoryDefaults).toMatch(/NOT inverter/i);
    // Present for the battery block, which is where they were traced from.
    expect(factoryDefaults("BulkChargeI")).not.toBeNull();
    expect(factoryDefaults("NoSuchSetting")).toBeNull();
  });
});
