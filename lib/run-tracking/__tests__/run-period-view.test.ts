import { describe, it, expect } from "@jest/globals";
import {
  avgPowerWFromEnergy,
  formatRunSignal,
  formatRunWhen,
  planRunPeriodColumns,
} from "../run-period-view";

/**
 * The expected unit-presentation flag when a case says nothing about the rows' units. Every case
 * that omits `rowSignalUnits` is VACUOUSLY homogeneous — there is no row unit to contradict the
 * header — so the header names the unit and cells stay bare, exactly as before migration 0055.
 */
const HOMOGENEOUS = { signalUnitPerRow: false };
/** The expected column flags when no row carries any provenance figure — all absent. */
const UNPRICED = { cost: false, emissions: false, renewable: false };
/** Rows that carry all three figures (Daylesford, once recomputed). */
const ALL_PRESENT = { cost: true, emissions: true, renewable: true };
/** Rows that carry none — an unpriced device, or a window recomputed before provenance existed. */
const NONE_PRESENT = { cost: false, emissions: false, renewable: false };

describe("avgPowerWFromEnergy", () => {
  it("derives average power from energy over duration", () => {
    // 3.3 kWh across exactly one hour = 3.3 kW.
    expect(avgPowerWFromEnergy(3.3, 3600)).toBeCloseTo(3300, 6);
    // Same energy in half the time = double the power.
    expect(avgPowerWFromEnergy(3.3, 1800)).toBeCloseTo(6600, 6);
  });

  it("reproduces the Daylesford 22 Jul run (~3.29 kW, not the 1.5 kW rpm÷1000 figure)", () => {
    // The regression this whole change exists for: the run showed 1.5 kW (1551 rpm ÷ 1000).
    expect(avgPowerWFromEnergy(3.29, 3600)).toBeCloseTo(3290, 6);
  });

  it("is null for an open run (no duration yet)", () => {
    expect(avgPowerWFromEnergy(1.5, null)).toBeNull();
    expect(avgPowerWFromEnergy(1.5, undefined)).toBeNull();
  });

  it("is null for an unmetered run (no energy)", () => {
    expect(avgPowerWFromEnergy(null, 3600)).toBeNull();
    expect(avgPowerWFromEnergy(undefined, 3600)).toBeNull();
  });

  it("is null — never Infinity — for a non-positive duration", () => {
    expect(avgPowerWFromEnergy(1.5, 0)).toBeNull();
    expect(avgPowerWFromEnergy(1.5, -60)).toBeNull();
  });

  it("keeps zero energy as zero power, not null", () => {
    expect(avgPowerWFromEnergy(0, 3600)).toBe(0);
  });
});

describe("formatRunSignal", () => {
  // A stand-in for applyExcelFormat: enough to tell the two formats apart without pulling the real
  // formatter (whose own behaviour is tested elsewhere).
  const fmt = (v: number, f: string) =>
    f === "0" ? String(Math.round(v)) : v.toFixed(1);
  const RPM = { unit: "rpm", format: "0" };

  it("prints a bare number when the column header carries the unit", () => {
    expect(formatRunSignal(1499.9, "rpm", RPM, false, fmt)).toBe("1500");
  });

  it("prints the unit on the CELL when the header cannot carry it", () => {
    expect(formatRunSignal(1499.9, "rpm", RPM, true, fmt)).toBe("1500 rpm");
  });

  it("🛑 does NOT print a superseded-unit row in the current unit", () => {
    // The regression in one line: a −3807.5 W row rendered under an rpm column. It must say "W",
    // and it must not borrow the rpm point's "0" format either.
    expect(formatRunSignal(-3807.5, "W", RPM, true, fmt)).toBe("-3807.5 W");
  });

  it("dashes a missing value rather than printing a bare unit", () => {
    expect(formatRunSignal(null, "rpm", RPM, true, fmt)).toBe("—");
    expect(formatRunSignal(undefined, "rpm", RPM, false, fmt)).toBe("—");
  });

  it("omits the suffix for a labelled-less row instead of printing 'null'", () => {
    expect(formatRunSignal(1500, null, RPM, true, fmt)).toBe("1500.0");
  });

  it("survives an unresolvable current signal", () => {
    expect(formatRunSignal(-3807.5, "W", null, true, fmt)).toBe("-3807.5 W");
  });
});

describe("planRunPeriodColumns", () => {
  it("collapses to one avg-power column when the signal IS power", () => {
    // A power-threshold site sees exactly today's table: one Avg Power column, no signal column.
    expect(
      planRunPeriodColumns({
        signalMetricType: "power",
        signalMetricUnit: "W",
        hasEnergyPoint: true,
      }),
    ).toEqual({
      signal: false,
      avgPower: true,
      avgPowerBasis: "energy",
      ...HOMOGENEOUS,
      ...UNPRICED,
    });
  });

  it("falls back to the signal statistic for a power signal with no energy point", () => {
    // Pre-existing behaviour, now gated so it can only happen when the signal really is power.
    expect(
      planRunPeriodColumns({
        signalMetricType: "power",
        signalMetricUnit: "W",
        hasEnergyPoint: false,
      }),
    ).toEqual({
      signal: false,
      avgPower: true,
      avgPowerBasis: "signal",
      ...HOMOGENEOUS,
      ...UNPRICED,
    });
  });

  it("shows both columns for a non-power signal with an energy point (Daylesford/rpm)", () => {
    expect(
      planRunPeriodColumns({
        signalMetricType: "speed",
        signalMetricUnit: "rpm",
        hasEnergyPoint: true,
      }),
    ).toEqual({
      signal: true,
      avgPower: true,
      avgPowerBasis: "energy",
      ...HOMOGENEOUS,
      ...UNPRICED,
    });
  });

  it("shows only the signal column for a non-power signal with no energy point", () => {
    // No energy point and a non-power signal means no honest power figure exists at all — show the
    // signal, and omit the power column rather than filling it with dashes.
    expect(
      planRunPeriodColumns({
        signalMetricType: "speed",
        signalMetricUnit: "rpm",
        hasEnergyPoint: false,
      }),
    ).toEqual({
      signal: true,
      avgPower: false,
      avgPowerBasis: "signal",
      ...HOMOGENEOUS,
      ...UNPRICED,
    });
  });

  it("fences out non-numeric signals whose mean would be meaningless", () => {
    for (const metricUnit of ["boolean", "text", "json", "epochMs"]) {
      expect(
        planRunPeriodColumns({
          signalMetricType: "status",
          signalMetricUnit: metricUnit,
          hasEnergyPoint: true,
        }).signal,
      ).toBe(false);
    }
  });

  it("degrades safely when the signal point has no point_info row", () => {
    expect(
      planRunPeriodColumns({
        signalMetricType: null,
        signalMetricUnit: null,
        hasEnergyPoint: true,
      }),
    ).toEqual({
      signal: false,
      avgPower: true,
      avgPowerBasis: "energy",
      ...HOMOGENEOUS,
      ...UNPRICED,
    });
  });

  it("never advertises two power columns, over the whole input space", () => {
    const metricTypes = [null, "power", "speed", "temperature", "status"];
    const metricUnits = [null, "W", "rpm", "°C", "boolean", "text"];
    for (const signalMetricType of metricTypes) {
      for (const signalMetricUnit of metricUnits) {
        for (const hasEnergyPoint of [true, false]) {
          const c = planRunPeriodColumns({
            signalMetricType,
            signalMetricUnit,
            hasEnergyPoint,
          });
          // The invariant: a power signal is never rendered as both a signal column and a power column.
          const twoPowerColumns =
            c.signal && c.avgPower && signalMetricType === "power";
          expect(twoPowerColumns).toBe(false);
          // And a signal-basis avg power is only ever claimed for a real power signal.
          if (c.avgPower && c.avgPowerBasis === "signal") {
            expect(signalMetricType).toBe("power");
          }
        }
      }
    }
  });

  it("shows the provenance columns when the rows carry the figures", () => {
    expect(
      planRunPeriodColumns({
        signalMetricType: "speed",
        signalMetricUnit: "rpm",
        hasEnergyPoint: true,
        provenance: ALL_PRESENT,
      }),
    ).toEqual({
      signal: true,
      avgPower: true,
      avgPowerBasis: "energy",
      ...HOMOGENEOUS,
      cost: true,
      emissions: true,
      renewable: true,
    });
  });

  // ── Mixed-unit history (migration 0055). THE case this stage exists for. ──────────────────
  //
  // Daylesford's detector was re-pointed from Selectronic grid power (W) to DSE Engine Speed (rpm),
  // so 74 of its 77 stored runs are Watts and 3 are rpm — permanently. The reader used to suppress
  // the statistic on the older rows because their unit was unrecoverable; now the unit is stored per
  // row, and what has to be prevented instead is a header that names ONE unit for all of them.

  it("goes per-row when a window straddles a re-point (the Daylesford 74 W + 3 rpm case)", () => {
    // 🛑 The exact regression the execution plan warned about: a naive dynamic header would read
    // "Avg Engine Speed (rpm)" — printing 74 rows of Watts as rpm. `signalUnitPerRow` is what stops
    // it: the header goes neutral and every cell carries its own unit.
    const c = planRunPeriodColumns({
      signalMetricType: "speed",
      signalMetricUnit: "rpm",
      rowSignalUnits: [...Array(74).fill("W"), ...Array(3).fill("rpm")],
      hasEnergyPoint: true,
    });
    expect(c.signalUnitPerRow).toBe(true);
    expect(c.signal).toBe(true);
  });

  it("goes per-row when EVERY row is in a superseded unit, not just a mixed window", () => {
    // Paging back far enough lands on a page that is entirely pre-re-point. It is homogeneous, but
    // in the WRONG unit — naming the current one would mislabel all of it. Homogeneity alone is not
    // the test; agreement with the CURRENT signal is.
    const c = planRunPeriodColumns({
      signalMetricType: "speed",
      signalMetricUnit: "rpm",
      rowSignalUnits: ["W", "W", "W"],
      hasEnergyPoint: true,
    });
    expect(c.signalUnitPerRow).toBe(true);
  });

  it("stays header-labelled when every row agrees with the current signal", () => {
    // The ordinary case, and it must NOT regress into per-cell units: that would put "rpm" on every
    // row of a table whose header could simply say it once.
    const c = planRunPeriodColumns({
      signalMetricType: "speed",
      signalMetricUnit: "rpm",
      rowSignalUnits: ["rpm", "rpm", "rpm"],
      hasEnergyPoint: true,
    });
    expect(c.signalUnitPerRow).toBe(false);
    expect(c.signal).toBe(true);
  });

  it("treats an empty window as homogeneous rather than mixed", () => {
    expect(
      planRunPeriodColumns({
        signalMetricType: "speed",
        signalMetricUnit: "rpm",
        rowSignalUnits: [],
        hasEnergyPoint: true,
      }).signalUnitPerRow,
    ).toBe(false);
  });

  it("ignores unlabelled rows when deciding homogeneity", () => {
    // A NULL signal_unit carries no claim about units, so it cannot make a window "mixed".
    expect(
      planRunPeriodColumns({
        signalMetricType: "speed",
        signalMetricUnit: "rpm",
        rowSignalUnits: [null, "rpm", null],
        hasEnergyPoint: true,
      }).signalUnitPerRow,
    ).toBe(false);
  });

  it("keeps the signal column when a POWER signal's window is mixed", () => {
    // Normally a power signal collapses into the avg-power column. That equivalence only holds while
    // every row IS power — with mixed units the avg-power column can speak for some rows only, so
    // the signal column has to stay and carry the rest.
    const c = planRunPeriodColumns({
      signalMetricType: "power",
      signalMetricUnit: "W",
      rowSignalUnits: ["W", "rpm"],
      hasEnergyPoint: false,
    });
    expect(c.signalUnitPerRow).toBe(true);
    expect(c.signal).toBe(true);
    // And it must NOT claim a signal-basis avg power over a window containing non-power rows.
    expect(c.avgPower).toBe(false);
  });

  it("still shows the labelled rows when the CURRENT signal point can't be resolved", () => {
    // A deleted/re-pointed binding used to hide the column entirely. A stored, self-describing
    // number is still worth showing — that is the point of storing the unit.
    const c = planRunPeriodColumns({
      signalMetricType: null,
      signalMetricUnit: null,
      rowSignalUnits: ["W", "W"],
      hasEnergyPoint: true,
    });
    expect(c.signal).toBe(true);
    expect(c.signalUnitPerRow).toBe(true);
  });

  it("never claims a signal-basis avg power over a mixed window, across the input space", () => {
    // The generalisation of the case above: a signal-basis avg power asserts "these values ARE
    // Watts", which a mixed window makes false by construction.
    const unitSets = [["W"], ["rpm"], ["W", "rpm"], [null], []];
    for (const signalMetricType of [null, "power", "speed"]) {
      for (const signalMetricUnit of [null, "W", "rpm"]) {
        for (const rowSignalUnits of unitSets) {
          for (const hasEnergyPoint of [true, false]) {
            const c = planRunPeriodColumns({
              signalMetricType,
              signalMetricUnit,
              rowSignalUnits,
              hasEnergyPoint,
            });
            if (c.avgPower && c.avgPowerBasis === "signal") {
              expect(signalMetricType).toBe("power");
              expect(c.signalUnitPerRow).toBe(false);
            }
          }
        }
      }
    }
  });

  it("gates each provenance column independently", () => {
    // `generatorSource` gates price separately from emissions, so a site with emissions but no
    // configured price writes rows with emissions_g and a NULL cost_c — the table must show CO₂ and
    // OMIT cost, never render it as $0.00.
    expect(
      planRunPeriodColumns({
        signalMetricType: "speed",
        signalMetricUnit: "rpm",
        hasEnergyPoint: true,
        provenance: { cost: false, emissions: true, renewable: true },
      }),
    ).toMatchObject({ cost: false, emissions: true, renewable: true });
  });

  it("omits every provenance column when no row carries a figure", () => {
    // A load-side device (EV, pump) is never priced today; so is any window recomputed before the
    // provenance columns existed. Absent, not zero.
    expect(
      planRunPeriodColumns({
        signalMetricType: "power",
        signalMetricUnit: "W",
        hasEnergyPoint: true,
        provenance: NONE_PRESENT,
      }),
    ).toMatchObject(UNPRICED);
  });

  it("omits provenance when the caller passes none (an untracked system)", () => {
    expect(
      planRunPeriodColumns({
        signalMetricType: "power",
        signalMetricUnit: "W",
        hasEnergyPoint: true,
      }),
    ).toMatchObject(UNPRICED);
  });

  it("follows the rows, not the config — the data is the only gate that can't lie", () => {
    // Provenance is accumulated at recompute time. Gating on live config instead would show three
    // empty columns the instant `generatorSource` is set (before any recompute), and would hide
    // columns over rows that still hold real figures the instant it is unset. Only the rows know.
    expect(
      planRunPeriodColumns({
        signalMetricType: "speed",
        signalMetricUnit: "rpm",
        hasEnergyPoint: true,
        provenance: ALL_PRESENT,
      }),
    ).toMatchObject(ALL_PRESENT);
  });
});

describe("formatRunWhen", () => {
  it("renders a same-day closed run as one range", () => {
    expect(
      formatRunWhen({
        date: "Tue 28 Jul",
        startTime: "14:32",
        endTime: "16:05",
      }),
    ).toBe("Tue 28 Jul, 14:32–16:05");
  });

  it("spells out a run that crosses midnight", () => {
    // The whole reason `endDate` exists: without it this reads as a Monday 23:40→01:15 range.
    expect(
      formatRunWhen({
        date: "Mon 27 Jul",
        startTime: "23:40",
        endDate: "Tue 28 Jul",
        endTime: "01:15",
      }),
    ).toBe("Mon 27 Jul, 23:40 – Tue 28 Jul, 01:15");
  });

  it("renders an open run as running to now", () => {
    expect(
      formatRunWhen({
        date: "Tue 28 Jul",
        startTime: "14:32",
        endTime: null,
        running: true,
      }),
    ).toBe("Tue 28 Jul, 14:32–now");
  });

  it("renders a degenerate run as a single instant, not an empty range", () => {
    expect(
      formatRunWhen({ date: "Tue 28 Jul", startTime: "14:32", endTime: null }),
    ).toBe("Tue 28 Jul, 14:32");
    expect(
      formatRunWhen({
        date: "Tue 28 Jul",
        startTime: "14:32",
        endTime: "14:32",
      }),
    ).toBe("Tue 28 Jul, 14:32");
  });

  it("keeps a midnight-crossing run that starts and ends at the same clock time", () => {
    // Same HH:mm but a different day is a 24h run, NOT an instant — the endDate must win.
    expect(
      formatRunWhen({
        date: "Mon 27 Jul",
        startTime: "14:32",
        endDate: "Tue 28 Jul",
        endTime: "14:32",
      }),
    ).toBe("Mon 27 Jul, 14:32 – Tue 28 Jul, 14:32");
  });

  it("uses an en dash, never a hyphen", () => {
    const s = formatRunWhen({
      date: "Tue 28 Jul",
      startTime: "14:32",
      endTime: "16:05",
    });
    expect(s).toContain("–");
    expect(s).not.toContain("-");
  });
});
