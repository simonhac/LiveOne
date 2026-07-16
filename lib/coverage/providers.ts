/**
 * Registry of coverage-repair providers — the external-API vendors whose gaps are re-fetchable.
 * Push vendors (Fronius/DeepSea) are excluded (their gaps aren't recoverable).
 */
import type { CoverageRepairProvider } from "./types";
import { amberProvider } from "@/lib/vendors/amber/coverage-repair";
import { openelectricityProvider } from "@/lib/vendors/openelectricity/coverage-repair";
import { sigenergyProvider } from "@/lib/vendors/sigenergy/coverage-repair";

export const COVERAGE_PROVIDERS: CoverageRepairProvider<unknown>[] = [
  amberProvider as CoverageRepairProvider<unknown>,
  openelectricityProvider as CoverageRepairProvider<unknown>,
  sigenergyProvider as CoverageRepairProvider<unknown>,
];
