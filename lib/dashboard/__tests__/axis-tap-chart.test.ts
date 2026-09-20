import { describe, it, expect } from "@jest/globals";
import { mayHaveAxisTapChart } from "../temporal-cards";
import { emptyDashboardV4, type DashboardV4 } from "../v4";
import { Area, newUuidV7 } from "@/lib/ids";

/**
 * `mayHaveAxisTapChart` — whether the navigator hides its prev/next pill on a phone.
 *
 * 🛑 The failure this guards is silent and total: on a touch device the pill is the ONLY window
 * control apart from a chart's axis strip, so a false positive on a dashboard with no chart leaves
 * a phone unable to reach yesterday at all, with nothing on screen to say so. The cases below are
 * the ones that decide that — a chartless document, a nested chart, and a hidden one.
 */
const area = Area.encode(newUuidV7());

const doc = (...children: DashboardV4["root"]["children"]): DashboardV4 => ({
  version: 4,
  root: { kind: "group", children },
});

describe("mayHaveAxisTapChart", () => {
  it("is false for an empty document", () => {
    expect(mayHaveAxisTapChart(emptyDashboardV4())).toBe(false);
  });

  it("is false for a dashboard of runs and hot-water cards — nothing to tap", () => {
    // These DO travel through time (`mayHaveTimeTravelingCard` is true for them), which is exactly
    // why the two questions are separate: such a dashboard shows the navigator AND keeps its
    // buttons.
    expect(
      mayHaveAxisTapChart(
        doc(
          { kind: "card", type: "runs", area },
          { kind: "card", type: "hotWater", area },
        ),
      ),
    ).toBe(false);
  });

  it("is true for either chart variant, at any depth", () => {
    for (const variant of ["lines", "stacked-areas"]) {
      expect(
        mayHaveAxisTapChart(
          doc({
            kind: "group",
            area,
            heading: true,
            children: [
              { kind: "card", type: "runs", area },
              { kind: "card", type: "chart", area, config: { variant } },
            ],
          }),
        ),
      ).toBe(true);
    }
  });

  it("ignores a chart inside a hidden subtree — it never renders, so it cannot be tapped", () => {
    expect(
      mayHaveAxisTapChart(
        doc({
          kind: "group",
          area,
          heading: true,
          hidden: true,
          children: [{ kind: "card", type: "chart", area }],
        }),
      ),
    ).toBe(false);
  });
});
