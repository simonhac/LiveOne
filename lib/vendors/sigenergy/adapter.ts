import { BaseVendorAdapter } from "../base-adapter";
import type {
  CredentialField,
  FetchContext,
  FetchResult,
  TestConnectionResult,
} from "../types";
import type { SystemWithPolling } from "@/lib/systems-manager";
import type { CommonPollingData } from "@/lib/types/common";
import { getNextMinuteBoundary } from "@/lib/date-utils";
import { SigenergyClient, SigenergyError } from "./sigenergy-client";
import { buildSigenergyReadings, sigenergyFlowToData } from "./point-metadata";
import type { SigenergyCredentials, SigenergyData } from "./types";

/**
 * Vendor adapter for Sigenergy (mySigen) systems.
 *
 * Per-user credentialed poll-snapshot vendor (mirrors Selectronic): each 5-minute poll fetches the
 * cloud energy-flow snapshot and emits raw PV/battery/grid/load/EV + SOC readings; Postgres computes
 * the 5m/1d aggregates. 5 minutes is the polling floor for the reverse-engineered cloud API.
 */
export class SigenergyAdapter extends BaseVendorAdapter {
  readonly vendorType = "sigenergy";
  readonly displayName = "Sigenergy";
  readonly dataSource = "poll" as const;
  readonly supportsAddSystem = true;

  protected pollIntervalMinutes = 5;
  protected toleranceSeconds = 30;
  // Poll on absolute 5-min boundaries (:00, :05 …) and retry each minute until a reading lands.
  protected alignToBoundary = true;

  readonly credentialFields: CredentialField[] = [
    {
      name: "username",
      label: "Email",
      type: "email",
      placeholder: "your@email.com",
      required: true,
      helpText: "Your mySigen account email",
    },
    {
      name: "password",
      label: "Password",
      type: "password",
      placeholder: "Enter your password",
      required: true,
      helpText: "Your mySigen account password",
    },
    {
      name: "region",
      label: "Region",
      type: "text",
      placeholder: "aus",
      required: false,
      helpText: "Cloud region: aus (default), eu, apac, us, or cn",
    },
  ];

  // Reuse a client per credential set so its access token (and ~12h refresh) survives across polls.
  private static clientCache = new Map<string, SigenergyClient>();

  private getClient(credentials: SigenergyCredentials): SigenergyClient {
    const region = credentials.region ?? "aus";
    const key = `${credentials.username}:${region}`;
    let client = SigenergyAdapter.clientCache.get(key);
    if (!client) {
      client = new SigenergyClient({
        username: credentials.username,
        password: credentials.password,
        region,
      });
      SigenergyAdapter.clientCache.set(key, client);
    }
    return client;
  }

  protected async fetchData(
    system: SystemWithPolling,
    credentials: SigenergyCredentials,
    context: FetchContext,
  ): Promise<FetchResult> {
    if (!system.vendorSiteId) {
      return {
        success: false,
        error: "System has no Sigenergy station id (vendorSiteId)",
      };
    }
    try {
      const client = this.getClient(credentials);
      const flow = await client.getEnergyFlow(system.vendorSiteId);
      const data = sigenergyFlowToData(flow, context.startedAt);
      const readings = buildSigenergyReadings(
        data,
        context.startedAt.getTime(),
      );

      // An all-null snapshot yields zero readings. Treat it as a failure (not a silent success) so
      // boundary-aligned scheduling keeps retrying this window instead of accepting an empty record.
      if (readings.length === 0) {
        return {
          success: false,
          error: "Empty energy-flow snapshot (all metrics null)",
          errorCode: "empty",
          rawResponse: flow.raw,
        };
      }

      console.log(
        `[Sigenergy] Fetch OK — Solar: ${data.solarW}W  Load: ${data.loadW}W  Battery: ${data.batteryW}W` +
          `  SOC: ${data.batterySOC != null ? data.batterySOC.toFixed(1) + "%" : "N/A"}` +
          `  Grid: ${data.gridW}W  EV: ${data.evW}W — ${readings.length} points`,
      );

      return {
        success: true,
        readings,
        recordsProcessed: readings.length,
        rawResponse: flow.raw,
        nextPollTime: getNextMinuteBoundary(
          this.pollIntervalMinutes,
          system.timezoneOffsetMin,
        ),
      };
    } catch (error) {
      const e = error instanceof SigenergyError ? error : null;
      // A bad/expired token can linger in the cached client — drop it so the next poll re-logs in.
      if (e?.kind === "auth") {
        SigenergyAdapter.clientCache.delete(
          `${credentials.username}:${credentials.region ?? "aus"}`,
        );
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        errorCode: e?.status ? String(e.status) : e?.kind,
      };
    }
  }

  async testConnection(
    _system: SystemWithPolling,
    credentials: SigenergyCredentials,
  ): Promise<TestConnectionResult> {
    try {
      const client = new SigenergyClient({
        username: credentials.username,
        password: credentials.password,
        region: credentials.region ?? "aus",
      });
      const station = await client.getStation();
      if (!station.stationId) {
        return {
          success: false,
          error: "Logged in, but no station was found for this account",
        };
      }
      const flow = await client.getEnergyFlow(station.stationId);
      const data = sigenergyFlowToData(flow, new Date());

      return {
        success: true,
        systemInfo: {
          vendorSiteId: station.stationId,
          displayName: station.name || `Sigenergy ${station.stationId}`,
          model: "Sigenergy",
          solarSize:
            station.pvCapacityKw != null
              ? `${station.pvCapacityKw}kW`
              : undefined,
          batterySize:
            station.batteryCapacityKwh != null
              ? `${station.batteryCapacityKwh}kWh`
              : undefined,
        },
        latestData: this.toCommon(data),
        vendorResponse: { station: station.raw, energyFlow: flow.raw },
      };
    } catch (error) {
      const e = error instanceof SigenergyError ? error : null;
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        errorCode: e?.status ? String(e.status) : e?.kind,
      };
    }
  }

  private toCommon(data: SigenergyData): CommonPollingData {
    return {
      timestamp: data.timestamp,
      solarW: data.solarW,
      loadW: data.loadW,
      batteryW: data.batteryW,
      gridW: data.gridW,
      batterySOC: data.batterySOC,
    };
  }
}
