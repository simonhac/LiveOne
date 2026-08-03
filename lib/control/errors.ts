/**
 * Vendor-agnostic dispatch errors for the command plane.
 *
 * `lib/control` must not know about any vendor, so it cannot catch (say)
 * `TeslaCommandProtocolError`. Each vendor capability translates its own infra/protocol
 * failures into one of these two, and the routes map them to HTTP without a vendor branch.
 *
 * The split is deliberate:
 *  - `ControlDispatchError` = we could not even attempt the command (no env, no owner,
 *    vehicle missing, vehicle asleep) → its own HTTP status.
 *  - `ControlRejectedError` = the vendor refused as a matter of protocol/config → 422 + code.
 *
 * A benign vendor decline (Tesla's `result:false, reason:"not_charging"`) is neither: it is
 * a RETURNED `{ok:false, reason}` and answers 200.
 */

/** Infra/unavailability thrown by a `ControlCapability.invoke`; maps 1:1 to an HTTP status. */
export class ControlDispatchError extends Error {
  constructor(
    message: string,
    readonly httpStatus: 400 | 404 | 501 | 503,
  ) {
    super(message);
    this.name = "ControlDispatchError";
  }
}

/** The vendor refused the command as a matter of protocol/config; maps to 422 + `code`. */
export class ControlRejectedError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ControlRejectedError";
  }
}
