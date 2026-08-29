/**
 * Manifest addressing — the constraint that lives in a database this package cannot see.
 *
 * LiveOne's `points` table has a unique index on (device_id, **logical_path**, **metric_type**)
 * and another on (device_id, physical_path). A pushed batch that contains two points colliding on
 * either pair fails the ENTIRE insert, so the device stops delivering *everything* — not just the
 * offending point — and the only symptom is a 503 and a growing spool.
 *
 * That happened on 2026-08-29: five new control points all shared the tidy-looking stem
 * `source.generator.control`, and sheephouse pushed nothing for ~28 minutes. The manifests live
 * here and the constraint lives there, so this test is the only place the two can be held
 * together.
 */

import { describe, it, expect } from "@jest/globals";
import { DEEPSEA_MANIFEST } from "../../sources/musher";
import { CONTROL_MANIFEST } from "../control";
import type { Manifest } from "../source";

/** Everything musher can send in one batch — the device points plus the control-plane synthetics. */
const ALL: Manifest = [...DEEPSEA_MANIFEST, ...CONTROL_MANIFEST];

function duplicates(keys: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) dupes.add(k);
    seen.add(k);
  }
  return [...dupes];
}

describe("musher's pushed manifest", () => {
  it("has no two points sharing (logicalPathStem, metricType)", () => {
    const addresses = ALL.map(
      (p) => `${p.logicalPathStem ?? "(null)"}/${p.metricType}`,
    );
    expect(duplicates(addresses)).toEqual([]);
  });

  it("has no two points sharing physicalPathTail", () => {
    expect(duplicates(ALL.map((p) => p.physicalPathTail))).toEqual([]);
  });

  it("has no two points sharing a values key (a later entry would silently win)", () => {
    expect(duplicates(ALL.map((p) => p.key))).toEqual([]);
  });

  it("declares metricType and metricUnit on every point (gusher drops readings without both)", () => {
    for (const p of ALL) {
      expect(p.metricType).toBeTruthy();
      expect(p.metricUnit).toBeTruthy();
    }
  });

  it("keeps the writable point at the address the DeepSea capability dispatches on", () => {
    // lib/vendors/deepsea/control.ts matches this exact string; the pair is a contract, not a
    // label, so renaming either half here must fail loudly rather than silently break the command.
    const runRequest = CONTROL_MANIFEST.find(
      (p) => p.physicalPathTail === "generator_run_request_min",
    );
    expect(runRequest).toBeDefined();
    expect(`${runRequest!.logicalPathStem}/${runRequest!.metricType}`).toBe(
      "source.generator.control.request/duration",
    );
  });
});
