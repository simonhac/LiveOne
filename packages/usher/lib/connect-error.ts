/**
 * A device connect that failed, with what is needed to say WHERE it failed — thrown by the device
 * clients, diagnosed by core/tunnel.ts (which knows the site and its WireGuard peer).
 */
export class DeviceConnectError extends Error {
  constructor(
    message: string,
    readonly host: string,
    readonly port: number,
    /** ETIMEDOUT, EHOSTUNREACH, ECONNREFUSED, … */
    readonly code: string,
  ) {
    super(message);
    this.name = "DeviceConnectError";
  }
}
