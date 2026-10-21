/**
 * Which pushed readings are the HUB's own state rather than something it read off a device.
 *
 * The usher hub merges its run supervisor's synthetic points (`CONTROL_MANIFEST`,
 * packages/usher/core/control.ts) into every tick — deliberately including the ticks whose device
 * read FAILED, so a stop-retry loop during an outage still reaches LiveOne. The consequence is that
 * "a batch arrived" stopped meaning "the device answered": for three days in October 2026 the
 * Daylesford controller had no power while gusher recorded a successful poll every five minutes, and
 * nothing that judges a device by its last success could see it.
 *
 * Every control-plane stem lives under `source.generator.control` (the manifest's own rule, so that
 * no stem can collide with a device register's); that prefix is the whole test.
 */
const CONTROL_PLANE_PREFIX = "source.generator.control";

export function isControlPlaneStem(stem: string | null | undefined): boolean {
  return (
    stem != null &&
    (stem === CONTROL_PLANE_PREFIX ||
      stem.startsWith(`${CONTROL_PLANE_PREFIX}.`))
  );
}

/**
 * A batch that carries readings, every one of them control-plane: the hub could not read the device
 * this tick. An empty batch is not one — there is nothing to judge.
 */
export function isControlOnlyBatch(
  stems: readonly (string | null | undefined)[],
): boolean {
  return stems.length > 0 && stems.every(isControlPlaneStem);
}
