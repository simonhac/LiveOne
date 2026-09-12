import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEEPSEA_MANIFEST } from "../../usher/sources/musher";
import { FUSHER_MANIFEST } from "../../usher/sources/fusher";
import {
  REGISTERS,
  CONTROL_MODE,
  ENGINE_STATE,
} from "../../usher/clients/dse-client";
import { SELECTRONIC_POINTS } from "../../../lib/vendors/selectronic/point-metadata";
import { SIGENERGY_POINTS } from "../../../lib/vendors/sigenergy/point-metadata";

describe("Go vendor metadata compatibility", () => {
  it("pins all manifests to their production TypeScript definitions", () => {
    const metadata = JSON.parse(
      readFileSync(
        resolve(__dirname, "../internal/gousher/assets/manifests.json"),
        "utf8",
      ),
    );
    expect(metadata).toEqual({
      deepsea: DEEPSEA_MANIFEST,
      fronius: FUSHER_MANIFEST,
      selectronic: SELECTRONIC_POINTS.map((p) => ({
        key: p.field,
        ...p.metadata,
      })),
      sigenergy: SIGENERGY_POINTS.map((p) => ({ key: p.field, ...p.metadata })),
    });
  });
  it("pins the complete DSE register map, signedness and sentinels", () => {
    const registers = JSON.parse(
      readFileSync(
        resolve(__dirname, "../internal/gousher/assets/registers.json"),
        "utf8",
      ),
    );
    expect(registers).toEqual({
      registers: REGISTERS,
      controlModes: CONTROL_MODE,
      engineStates: ENGINE_STATE,
    });
  });
});
