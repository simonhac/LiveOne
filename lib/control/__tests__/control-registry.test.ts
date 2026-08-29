/**
 * The control registry — writability is decided server-side, and is closed by default.
 *
 * The property that matters: a pushed reading cannot make its own point writable. `/api/gush` is
 * self-describing for everything EXCEPT `control`, because a `gk_` key is a device credential and
 * a device must not be able to widen the command surface.
 */
import { describe, it, expect } from "@jest/globals";
import { resolvePointControl } from "../control-registry";

describe("resolvePointControl", () => {
  it("returns the descriptor for the generator run-request point", () => {
    expect(
      resolvePointControl("deepsea", "generator", "generator_run_request_min"),
    ).toEqual({ kind: "number", min: 0, max: 120, step: 5 });
  });

  it("is case-insensitive on vendorType (device rows are not normalised)", () => {
    expect(
      resolvePointControl("DeepSea", "generator", "generator_run_request_min"),
    ).not.toBeNull();
  });

  it("returns null for every other deepsea point — closed by default", () => {
    for (const tail of [
      "engine_rpm",
      "battery_v",
      "gen_freq_hz",
      "control_run_active",
      "control_state",
      "remote_start_input",
    ]) {
      expect(resolvePointControl("deepsea", "generator", tail)).toBeNull();
    }
  });

  it("returns null for an unknown vendor, subsystem, or missing either", () => {
    expect(
      resolvePointControl("fronius", "generator", "generator_run_request_min"),
    ).toBeNull();
    expect(
      resolvePointControl("deepsea", "inverter", "generator_run_request_min"),
    ).toBeNull();
    expect(
      resolvePointControl(null, "generator", "generator_run_request_min"),
    ).toBeNull();
    expect(
      resolvePointControl("deepsea", null, "generator_run_request_min"),
    ).toBeNull();
  });

  it("cannot be tricked into writability by a lookalike path tail", () => {
    for (const tail of [
      "generator_run_request_min ",
      "Generator_Run_Request_Min",
      "../generator_run_request_min",
      "generator_run_request_min_x",
    ]) {
      expect(resolvePointControl("deepsea", "generator", tail)).toBeNull();
    }
  });
});
