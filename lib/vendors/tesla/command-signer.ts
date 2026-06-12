/**
 * Tesla command transport — pluggable signing seam.
 *
 * Charge commands (`command/*`) are the only Tesla calls subject to the Vehicle
 * Command protocol. Pre-2021 Model S/X are EXEMPT and accept plain unsigned REST
 * (`DirectCommandSigner`). 2021+ cars REQUIRE signed commands — a future
 * `ProxyCommandSigner` (Tesla vehicle-command SDK / tesla-http-proxy) slots in here
 * without touching `TeslaClient` or its callers.
 *
 * Reads (`vehicle_data`) and `wake_up` are never signed, so they don't go through this.
 */

import type { TeslaCommandResult } from "./types";

export interface TeslaCommandRequest {
  /** Regional Fleet API base URL, e.g. https://fleet-api.prd.na.vn.cloud.tesla.com */
  baseUrl: string;
  accessToken: string;
  vehicleId: string;
  /** Command tail, e.g. "charge_start", "set_charging_amps". */
  command: string;
  /** JSON body for parameterised commands (percent / charging_amps). */
  body?: Record<string, unknown>;
}

export interface TeslaCommandSigner {
  send(req: TeslaCommandRequest): Promise<TeslaCommandResult>;
}

/**
 * Thrown when a vehicle rejects an unsigned command (HTTP 403). This is the signal
 * that the car is NOT exempt and needs a signing proxy/SDK (Phase 2) — surfaced
 * distinctly so callers/UI can explain it rather than showing a generic failure.
 */
export class TeslaCommandProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeslaCommandProtocolError";
  }
}

/**
 * Direct (unsigned) command transport over plain Fleet REST. Correct for
 * signing-exempt vehicles (pre-2021 Model S/X).
 */
export class DirectCommandSigner implements TeslaCommandSigner {
  async send(req: TeslaCommandRequest): Promise<TeslaCommandResult> {
    const url = `${req.baseUrl}/api/1/vehicles/${req.vehicleId}/command/${req.command}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${req.accessToken}`,
        "Content-Type": "application/json",
      },
      body: req.body ? JSON.stringify(req.body) : undefined,
    });

    const text = await response.text();

    // 403 with a signing message means the car requires the Vehicle Command protocol.
    if (
      response.status === 403 &&
      /vehicle command protocol|signed command|key paired|unsigned/i.test(text)
    ) {
      throw new TeslaCommandProtocolError(
        `Vehicle requires signed commands (Vehicle Command protocol): ${text}`,
      );
    }

    if (!response.ok) {
      throw new Error(
        `Tesla command '${req.command}' failed: ${response.status} ${text}`,
      );
    }

    // Tesla envelope: { response: { result: boolean, reason: string } }
    let parsed: { response?: { result?: boolean; reason?: string } } | null =
      null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // fall through to default below
    }
    const result = parsed?.response;

    return {
      result: result?.result === true,
      reason: typeof result?.reason === "string" ? result.reason : "",
    };
  }
}

// Default transport used by TeslaClient unless a signer is injected.
export const directCommandSigner = new DirectCommandSigner();
