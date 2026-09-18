import { BaseVendorAdapter } from "../base-adapter";
import type {
  TestConnectionResult,
  CredentialField,
  FetchContext,
  FetchResult,
} from "../types";
import type { DeviceConfigView } from "@/lib/registry/device-config";
import type { CommonPollingData } from "@/lib/types/common";
import {
  SelectronicFetchClient,
  type SelectronicData,
} from "./selectronic-client";
import { SELECTRONIC_POINTS } from "./point-metadata";
import {
  faultLegOff,
  FAULT_LEG_BUDGET_MS,
  observePortalEvents,
  resolveFaultPoints,
  type FaultObservation,
} from "./diagnostics";

/**
 * How long a cached select.live session may be reused.
 *
 * The portal's session lasts ~30 minutes; 20 leaves margin, in the same spirit as Sigenergy
 * refreshing its token 5 minutes before expiry. The TTL matters even though a Vercel process only
 * lives ~33 minutes on average — that is the SAME ORDER as the session, so without it a
 * longer-lived process would eventually present an expired cookie.
 */
export const SELECTRONIC_SESSION_TTL_MS = 20 * 60 * 1000;

/**
 * Vendor adapter for Selectronic/Select.Live devices
 */
export class SelectronicAdapter extends BaseVendorAdapter {
  readonly vendorType = "selectronic";
  readonly displayName = "Selectronic";
  readonly dataSource = "poll" as const;
  readonly supportsAddDevice = true;

  // Selectronic polls every minute
  protected pollIntervalMinutes = 1;

  readonly credentialFields: CredentialField[] = [
    {
      name: "email",
      label: "Email",
      type: "email",
      placeholder: "your@email.com",
      required: true,
      helpText: "Your Select.Live account email",
    },
    {
      name: "password",
      label: "Password",
      type: "password",
      placeholder: "Enter your password",
      required: true,
      helpText: "Your Select.Live account password",
    },
    {
      // Only used by the diagnostic acquisition (lib/diagnostics/acquire.ts), which authenticates
      // to the INVERTER itself over the SP LINK tunnel — a challenge-response separate from the
      // portal login. Optional: the factory default works on an unchanged installation.
      name: "inverterPassword",
      label: "Inverter password",
      type: "password",
      placeholder: "Leave blank for the factory default",
      required: false,
      helpText:
        "Only needed for internal fault-log diagnostics. Blank uses the factory default.",
    },
  ];

  /**
   * Reuse a client per credential set so its SESSION COOKIE survives across polls.
   *
   * The cookies live in a private Map INSIDE `SelectronicFetchClient`, so caching the client is
   * what preserves them — the same shape as `SigenergyAdapter.clientCache`, which caches the object
   * that holds the credential rather than a note saying one was obtained. The cache this replaced
   * stored the literal string `"authenticated"` and was never read back into a client, so every
   * poll built a cookieless client and `fetchData`'s own `cookies.size === 0` guard logged in
   * again. Measured on prod: 57 fetches produced 57 logins, 49 of them on polls where the cache
   * had "hit" — 1440 logins/day against select.live where ~44 suffice (one per process lifetime).
   */
  private static clientCache = new Map<string, SelectronicFetchClient>();

  /**
   * Fetch data from Selectronic API
   * Base adapter handles session creation, data insertion, and session completion
   */
  protected async fetchData(
    device: DeviceConfigView,
    credentials: any,
    context: FetchContext,
  ): Promise<FetchResult> {
    const cacheKey = `${credentials.email}:${device.vendorSiteId}`;
    try {
      let client = SelectronicAdapter.clientCache.get(cacheKey);
      const age = client?.sessionAgeMs() ?? null;

      // `!client` is implied by `age === null`, but stating it lets TS narrow away the assertion.
      if (!client || age === null || age >= SELECTRONIC_SESSION_TTL_MS) {
        client = new SelectronicFetchClient({
          email: credentials.email,
          password: credentials.password,
          systemNumber: device.vendorSiteId,
        });
        console.log(
          `[Selectronic] Authenticating for system ${device.vendorSiteId}...`,
        );
        const authResult = await client.authenticate();

        if (!authResult) {
          return {
            success: false,
            error: "Authentication failed",
            errorKind: "auth",
          };
        }

        SelectronicAdapter.clientCache.set(cacheKey, client);
      }

      const response = await client.fetchData();

      /**
       * The Events page is fetched INDEPENDENTLY of the readings, and deliberately before the
       * failure branch below.
       *
       * Across the three Daylesford interruptions of 17–18 September 2026 the readings request
       * failed for minutes at a time while the portal went on retaining the faults that explained
       * them. Returning early on a readings failure would have thrown that away in exactly the
       * window it mattered. So the fault history is retained and a diagnostic acquisition may still
       * be triggered even when this poll has no readings — what is NOT written in that case is the
       * fault POINTS, because a point needs a measurement time and this poll has none it can vouch
       * for. The durable record is `device_events`; the points are the monitoring summary.
       */
      //
      // 🛑 BOUNDED. Two HTTP requests and a retention write sit between a successful readings fetch
      // and this function returning, so without a ceiling a slow Events page or a slow database
      // could spend the poll's whole budget AFTER the readings were already in hand. The budget
      // covers the leg end to end; overrunning it yields an unavailable observation, which the
      // fault-point rules already treat as "we do not know", never as a clearance.
      const observation: FaultObservation = device.config?.diagnostics
        ?.portalEvents
        ? await SelectronicAdapter.withFaultLegBudget(
            observePortalEvents(device, client, response.data?.faultCode),
          )
        : faultLegOff();
      if (observation.state === "unavailable")
        console.warn(`[Selectronic] ${observation.reason}`);

      if (!response.success || !response.data) {
        // A session the portal has rejected must not be handed to the next poll. Only `auth`
        // evicts: a 504 or a reset says nothing about whether the cookie is still good, and
        // throwing the session away would put us straight back to logging in every poll.
        if (response.errorKind === "auth")
          SelectronicAdapter.clientCache.delete(cacheKey);
        return {
          success: false,
          error: response.error || "Failed to fetch data",
          errorCode: response.errorCode,
          errorKind: response.errorKind,
        };
      }

      const vendorData = response.data;
      const transformed = this.transformData(vendorData);
      const measurementTime = vendorData.timestamp.getTime();

      // The two fault points are resolved from BOTH sources together, so they are computed once
      // here rather than read straight off the vendor payload in the loop.
      //
      // 🪦 What used to be here: a branch skipping a zero `fault_code`/`fault_ts`. It tested
      // `physicalPathTail.endsWith("/fault_code")` while the tail is the unprefixed `fault_code`,
      // so it never matched once and zeros were written all along. It is gone rather than fixed:
      // writing the zero is CORRECT, because it is what clears a previous fault. Skipping it would
      // leave the last nonzero code standing as the latest value for ever.
      const { faultCode, faultTsMs } = resolveFaultPoints(
        vendorData.faultCode,
        vendorData.faultTimestamp,
        observation,
      );

      // Build readings array from all configured points
      const readings = [];
      for (const pointConfig of SELECTRONIC_POINTS) {
        let rawValue = vendorData[pointConfig.field];
        if (pointConfig.field === "faultCode") rawValue = faultCode;
        // The point declares `epochMs`; the vendor field is Unix SECONDS.
        if (pointConfig.field === "faultTimestamp") rawValue = faultTsMs;

        // Skip null/undefined values
        if (rawValue == null) {
          continue;
        }

        // Convert energy totals from kWh to Wh (multiply by 1000)
        if (pointConfig.metadata.metricType === "energy") {
          rawValue = Math.round(Number(rawValue) * 1000);
        }

        readings.push({
          pointMetadata: pointConfig.metadata,
          rawValue,
          measurementTime,
          dataQuality: "good" as const,
          error: null,
        });
      }

      console.log(
        `[Selectronic] Fetch successful -`,
        "Solar:",
        transformed.solarW,
        "W",
        "Load:",
        transformed.loadW,
        "W",
        "Battery:",
        transformed.batteryW,
        "W",
        "SOC:",
        transformed.batterySOC != null
          ? transformed.batterySOC.toFixed(1) + "%"
          : "N/A",
        `- ${readings.length} points`,
      );

      return {
        success: true,
        readings,
        recordsProcessed: readings.length,
        rawResponse: response.rawResponse,
      };
    } catch (error) {
      console.error(
        `[Selectronic] Error fetching data for system ${device.id}:`,
        error,
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
  /**
   * Cap the fault leg, without letting a slow one become a failed poll.
   *
   * A timeout here abandons the WAIT, not the work: the retention transaction either commits or is
   * rolled back by the database when the function ends. Nothing partial is left behind by giving up
   * on it, and the next poll re-reads the same page.
   */
  private static async withFaultLegBudget(
    work: Promise<FaultObservation>,
  ): Promise<FaultObservation> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<FaultObservation>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            ...faultLegOff(),
            state: "unavailable",
            parseComplete: false,
            reason: `Event history took longer than ${FAULT_LEG_BUDGET_MS} ms; abandoned for this poll.`,
          }),
        FAULT_LEG_BUDGET_MS,
      );
    });
    try {
      return await Promise.race([work, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  async testConnection(
    device: DeviceConfigView,
    credentials: any,
  ): Promise<TestConnectionResult> {
    try {
      // If no vendorSiteId provided, we need to discover available devices
      if (!device.vendorSiteId) {
        const discoveryClient = new SelectronicFetchClient({
          email: credentials.email,
          password: credentials.password,
          systemNumber: "", // Empty to discover devices
        });

        // Authenticate first
        const authSuccess = await discoveryClient.authenticate();
        if (!authSuccess) {
          return {
            success: false,
            error: "Failed to authenticate with Select.Live",
          };
        }

        // Get available devices
        const availableDevices = await discoveryClient.getDevicesList();

        if (!availableDevices || availableDevices.length === 0) {
          return {
            success: false,
            error: "No systems found for this Select.Live account",
          };
        }

        // Use the first device (in future we could let user choose)
        const firstDevice = availableDevices[0];
        const vendorSiteId =
          firstDevice.serialNumber || firstDevice.systemNumber;

        // Now test with the discovered device
        const client = new SelectronicFetchClient({
          email: credentials.email,
          password: credentials.password,
          systemNumber: vendorSiteId,
        });

        const result = await client.fetchData();
        if (!result.success || !result.data) {
          return {
            success: false,
            error: result.error || "Failed to fetch data from Select.Live",
          };
        }

        const deviceInfo = await client.fetchDeviceInfo();
        const latestData = this.transformData(result.data);

        return {
          success: true,
          deviceInfo: {
            vendorSiteId,
            displayName: firstDevice.name || `Selectronic ${vendorSiteId}`,
            model: deviceInfo?.model || firstDevice.model || "SP PRO",
            serial: deviceInfo?.serial || firstDevice.serialNumber,
            solarSize: deviceInfo?.solarSize,
            batterySize: deviceInfo?.batterySize,
            ratings: deviceInfo?.ratings,
          },
          latestData,
          vendorResponse: { devices: availableDevices, data: result.data.raw },
        };
      }

      // Normal flow when vendorSiteId is provided
      const client = new SelectronicFetchClient({
        email: credentials.email,
        password: credentials.password,
        systemNumber: device.vendorSiteId,
      });

      // Authenticate
      const authSuccess = await client.authenticate();
      if (!authSuccess) {
        return {
          success: false,
          error: "Failed to authenticate with Select.Live",
        };
      }

      // Fetch current data
      const result = await client.fetchData();
      if (!result.success || !result.data) {
        return {
          success: false,
          error: result.error || "Failed to fetch data from Select.Live",
        };
      }

      // Also fetch device info
      const deviceInfo = await client.fetchDeviceInfo();
      console.log(
        "[Selectronic] System info received:",
        JSON.stringify(deviceInfo, null, 2),
      );

      const latestData = this.transformData(result.data);

      return {
        success: true,
        deviceInfo: deviceInfo || undefined,
        latestData,
        vendorResponse: result.data.raw, // Include raw vendor response
      };
    } catch (error) {
      console.error("Error testing Selectronic connection:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Transform Selectronic vendor data to common format
   */
  private transformData(vendorData: SelectronicData): CommonPollingData {
    return {
      timestamp: vendorData.timestamp, // Already a Date object from client
      solarW: vendorData.solarW,
      solarLocalW: vendorData.shuntW, // Map old field name
      solarRemoteW: vendorData.solarInverterW, // Map old field name
      loadW: vendorData.loadW,
      batteryW: vendorData.batteryW,
      gridW: vendorData.gridW,
      batterySOC: vendorData.batterySOC,
      faultCode:
        vendorData.faultCode != null && vendorData.faultCode !== 0
          ? String(vendorData.faultCode)
          : null,
      faultTimestamp:
        vendorData.faultTimestamp != null && vendorData.faultTimestamp !== 0
          ? new Date(vendorData.faultTimestamp * 1000)
          : null, // Convert Unix timestamp to Date, 0 to null
      generatorStatus: vendorData.generatorStatus || null, // Convert 0 to null when no generator
      // Lifetime totals
      solarKwhTotal: vendorData.solarKwhTotal,
      loadKwhTotal: vendorData.loadKwhTotal,
      batteryInKwhTotal: vendorData.batteryInKwhTotal,
      batteryOutKwhTotal: vendorData.batteryOutKwhTotal,
      gridInKwhTotal: vendorData.gridInKwhTotal,
      gridOutKwhTotal: vendorData.gridOutKwhTotal,
    };
  }
}
