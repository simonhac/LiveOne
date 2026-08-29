/**
 * Point ADDRESSES (`logicalPath/metricType`) that the command plane's shared copy layers switch on.
 *
 * These live here, apart from the vendor modules that dispatch them, because `lib/control` must not
 * import a vendor (the `lib/control/errors.ts` rule). They are contracts either way: the pair is
 * what `lib/vendors/deepsea/control.ts` and `lib/vendors/tesla/control.ts` resolve a command by, so
 * renaming a logical path or a metric type breaks the command, not just a label.
 */

/** The DeepSea generator run request, in MINUTES (0 stops). Mirrors `RUN_REQUEST_ADDRESS`. */
export const GENERATOR_RUN_REQUEST_ADDRESS =
  "source.generator.control.request/duration";

/** Every Tesla charge-control address, for the copy layers' "is this a car" test. */
export const TESLA_CHARGE_ADDRESSES = [
  "ev.charge/active",
  "ev.charge.limit/soc",
  "ev.charge.limit/current",
] as const;
