/**
 * The `derivations.kind` vocabulary.
 *
 * Its own module purely to break an import cycle: `resolve.ts` reads `derivation_sources` through
 * `sources.ts`, and `sources.ts` needs the kinds to spell the per-kind slot vocabulary. Both used to
 * live in `resolve.ts`, which is still where they are re-exported from — no caller needs to know
 * this file exists.
 */
export const RUN_DETECTOR_KIND = "run-detector";
export const HWS_MODEL_KIND = "hws-model";
