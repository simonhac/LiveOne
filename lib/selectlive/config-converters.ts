/**
 * Conversions from a stored configuration word to a value a person can read.
 *
 * Every entry here was traced from the corresponding `mConfig.subUpdate*Setting` method in SP
 * LINK 16.11.9663; the arithmetic is the vendor's, not an inference from plausible-looking
 * numbers. `tools/splink/README.md` documents how to re-read them.
 *
 * 🛑 Only a subset is implemented, deliberately. About 35 of the vendor's converters are enums
 * that each need their own extracted code-to-string table, and a bulk-derived label is a
 * confident wrong fact in a manifest somebody reads a year later during an incident. A setting
 * whose converter is absent here is reported as `converter_not_implemented` WITH its raw word,
 * which is a worse answer to read and a much better one to trust. Adding a converter later is a
 * `CONFIG_DECODER_VERSION` bump and nothing else.
 */

interface ConverterContext {
  /** Series cell count for the connected model, or null when the model code is unknown. */
  batteryCells: number | null;
}

export interface Converter {
  /** How many consecutive words the vendor passes to this converter. */
  words: number;
  unit?: string;
  /** The decoded value, or null when context is missing (an unknown model, say). */
  decode(raw: number[], context: ConverterContext): string | number | null;
}

/**
 * The vendor's `mLowLevelDataManipulation.RealRound`, reproduced exactly.
 *
 * 🛑 NOT `toFixed`. SP LINK adds a signed half-unit and truncates, in **decimal** arithmetic:
 * `trunc((value + sign x 0.5 / 10^places) x 10^places) / 10^places`. JavaScript's `toFixed`
 * rounds a **binary** double, and the two disagree exactly on the midpoints this produces —
 * `(1.005).toFixed(2)` is `"1.00"`, because 1.005 is stored as 1.00499…, where SP LINK gives
 * 1.01. A snapshot that differs from the vendor in its last digit is the kind of discrepancy
 * somebody would later mistake for a setting having changed.
 *
 * Taking the value as a fraction keeps this exact: every conversion here is an integer word over
 * an integer divisor, so the whole computation stays in integers and never touches a binary
 * fraction. Inputs are 16-bit words, so nothing approaches the safe-integer limit.
 */
function realRound(
  numerator: number,
  denominator: number,
  places: number,
): number {
  const scale = 10 ** places;
  const half = numerator < 0 ? -denominator : denominator;
  return Math.trunc((2 * numerator * scale + half) / (2 * denominator)) / scale;
}

const scaled = (
  denominator: number,
  places: number,
  unit?: string,
): Converter => ({
  words: 1,
  unit,
  decode: ([raw]) => realRound(raw, denominator, places),
});

/** Minutes from midnight, as the vendor's `TimeSerial(value \ 60, value Mod 60, 0)`. */
const clockTime = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * One day in minutes — the boundary all three time converters are written around.
 *
 * 🛑 Only `StopTimeWithDisableSetting` treats it as "disabled", and only on an EXACT match:
 * the vendor tests `>= 1440` to leave the time path, then `= 1440` to choose "Disabled" and
 * sends anything larger to its error path. A blanket `>= 1440` would report a corrupt or
 * future word such as 1500 as the plausible, specific and false value `Disabled`.
 */
const MINUTES_PER_DAY = 1440;

/** A time-of-day word, or an honest refusal. 1500 is not 25:00. */
const timeOfDay = (raw: number): string =>
  raw < MINUTES_PER_DAY ? clockTime(raw) : `UNDECODED(${raw})`;

export const CONVERTERS: Record<string, Converter> = {
  // --- Plain arithmetic -----------------------------------------------------------------
  NumericalSetting: { words: 1, decode: ([raw]) => raw },
  // Identical to NumericalSetting; the vendor's extra flag only resizes the widget.
  NumericalSettingAndFitNud: { words: 1, decode: ([raw]) => raw },
  NumericalSettingAndChangeSign: { words: 1, decode: ([raw]) => -raw },
  NumericalSettingWithOffSetOf10000: {
    words: 1,
    decode: ([raw]) => raw - 10000,
  },
  CTRatioSetting: { words: 1, decode: ([raw]) => raw * 5 },
  NumericalSettingWhichIsStoredInDeciUnits: scaled(10, 1),
  NumericalSettingWhichIsStoredInCentiUnits: scaled(100, 2),
  NumericalSettingInUnitsWhichIsStoredInMiliUnits: scaled(1000, 2),
  NumericalSettingWhichIsStoredInQuinquadeciUnits: scaled(15, 1),
  NumericalSettingWhichIsDisplayedInHoursButStoredInMinutes: scaled(60, 1, "h"),
  NumericalSettingWhichIsStoredInDeciUnitsAndChangeSign: {
    words: 1,
    decode: ([raw]) => realRound(-raw, 10, 1),
  },
  NumericalSettingWhichIsStoredInDeciUnitsOffset100: {
    words: 1,
    // 🛑 The vendor rounds BEFORE subtracting, so this is not (raw - 1000) / 10.
    decode: ([raw]) => realRound(raw, 10, 1) - 100,
  },
  NumericalSetting_TemperatureCoefficient: {
    words: 1,
    decode: ([raw]) => realRound(raw - 10000, 1000, 1),
  },

  // --- Model-dependent ------------------------------------------------------------------
  /**
   * 🛑 Battery voltages are stored per cell. The same word reads 57.6 V on a 48 V SPMC482 and
   * 28.8 V on a 24 V SPMC241, so an unknown model must produce null rather than a number that
   * is wrong by a factor of two while looking entirely reasonable.
   */
  DCVoltageSetting: {
    words: 1,
    unit: "V",
    decode: ([raw], { batteryCells }) =>
      batteryCells === null ? null : realRound(raw * batteryCells, 1000, 1),
  },

  // --- Time -----------------------------------------------------------------------------
  TimeSetting: { words: 1, decode: ([raw]) => timeOfDay(raw) },
  // The vendor rejects every value at or above a full day here; there is no "disabled" form.
  StopTimeWithoutDisableSetting: {
    words: 1,
    decode: ([raw]) => timeOfDay(raw),
  },
  StopTimeWithDisableSetting: {
    words: 1,
    decode: ([raw]) => (raw === MINUTES_PER_DAY ? "Disabled" : timeOfDay(raw)),
  },

  // --- Small enums, traced in full ------------------------------------------------------
  LogicalSetting: {
    words: 1,
    decode: ([raw]) =>
      raw === 0 ? "Disabled" : raw === 1 ? "Enabled" : `UNDECODED(${raw})`,
  },
  DataLogIntervalSetting: {
    words: 1,
    unit: "min",
    decode: ([raw]) =>
      [1, 5, 10, 15, 30].includes(raw) ? raw : `UNDECODED(${raw})`,
  },
};

/**
 * Converters the vendor has that this file deliberately does not.
 *
 * Listed rather than left implicit so that `config-map.test.ts` can fail when the extractor
 * introduces a converter nobody has decided about -- an unknown converter should be a decision,
 * not a silent `converter_not_implemented` in every future manifest.
 */
export const KNOWN_UNIMPLEMENTED = new Set([
  "AccPortSetting",
  "AdvancedMultiplePhasePhaseSetting",
  "AdvancedMultiplePhaseStructureSetting",
  "AlarmTypeSetting",
  "AnalogueInputSelectionSetting",
  "AppTypeSetting",
  "AverageBatteryToStartGeneratorSetting",
  "BatteryTypeSetting",
  "BaudRateSetting",
  "BeepControlSetting",
  "ChargerLockoutSetting",
  "ChargerOverrideACSourceLimitSetting",
  "ControlStateSetting",
  // Day and month share one word for schedule dates but occupy two for the year-to-date
  // rollover. The packing of the single-word form is not traced, and a half-right date is
  // worse than none.
  "DayMonthSetting",
  "DigitalInputSelectionSetting",
  "EdgeSelectionSetting",
  "ExportImportSetting",
  "FrequencySetting",
  "GeneratorAvailableSetting",
  "GenericAcCouplingSetting",
  // One word carries both a value and its unit selector, and the same raw number means
  // `raw / 100` kW or `raw * 10 / 240` A. The encoding of the selector is not traced.
  "InputPowerSetting",
  "LevelSelectionSetting",
  "ModbusPortSetting",
  "ModeSetting",
  "MultiplePhaseSetting",
  "OutputSelectionSetting",
  "ParallelSetting",
  "PeriodicEqualiseSetting",
  "PortSetting",
  "PowerFactorModeSetting",
  "RegionSetting",
  "ScheduleSetting",
  "ShuntNameSetting",
  "SoftBatterySetting",
  "ThreePhaseAcSourceBalancedSetting",
]);
