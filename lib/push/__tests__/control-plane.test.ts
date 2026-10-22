import { describe, it, expect } from "@jest/globals";
import { isControlOnlyBatch, isControlPlaneStem } from "../control-plane";
import { CONTROL_MANIFEST } from "../../../packages/usher/core/control";

describe("isControlPlaneStem", () => {
  it("🛑 recognises every stem in the hub's CONTROL_MANIFEST", () => {
    // If the hub grows a control point outside the prefix, a dead controller would once again look
    // like a successful poll. Pin the manifest, not a hand-copied list.
    for (const entry of CONTROL_MANIFEST)
      expect(isControlPlaneStem(entry.logicalPathStem)).toBe(true);
  });

  it("does not claim device registers", () => {
    expect(isControlPlaneStem("generator.engine")).toBe(false);
    expect(isControlPlaneStem("source.generator.battery")).toBe(false);
    expect(isControlPlaneStem("source.generator.mode")).toBe(false);
    expect(isControlPlaneStem("source.generator.controller")).toBe(false);
    expect(isControlPlaneStem(null)).toBe(false);
  });
});

describe("isControlOnlyBatch", () => {
  it("is true only when every reading is control-plane", () => {
    expect(
      isControlOnlyBatch([
        "source.generator.control.status",
        "source.generator.control.error",
      ]),
    ).toBe(true);
    expect(
      isControlOnlyBatch([
        "source.generator.control.status",
        "generator.engine",
      ]),
    ).toBe(false);
    expect(isControlOnlyBatch([])).toBe(false);
  });
});
