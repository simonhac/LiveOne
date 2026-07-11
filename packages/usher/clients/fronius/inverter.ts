import axios from "axios";
import {
  EnergyIntegrator,
  BidirectionalEnergyIntegrator,
} from "./energy-integrator";
import { InverterInfo, BatteryInfo, MeterInfo } from "./types";

export interface PowerData {
  solarW?: number;
  batteryW?: number;
  gridW?: number;
  batterySoC?: number;
  timestamp: Date;
}

export interface EnergyData {
  solarWh: number;
  batteryInWh: number;
  batteryOutWh: number;
  gridInWh: number;
  gridOutWh: number;
}

export interface InverterStatus {
  code?: number;
  reason?: string;
  message?: string;
}

// Map device type codes to model names
const DEVICE_TYPE_MAP: Record<number, string> = {
  1: "Gen24",
  // Add more device types as discovered
};

export class Inverter {
  private ip: string;
  private serialNumber: string;
  private isMaster: boolean;
  private hostname?: string;

  // Device information
  private info: InverterInfo;
  private battery?: BatteryInfo;
  private meter?: MeterInfo;

  // Energy integrators
  private solarIntegrator: EnergyIntegrator;
  private batteryIntegrator: BidirectionalEnergyIntegrator | null = null;
  private gridIntegrator: BidirectionalEnergyIntegrator | null = null;

  // Latest data
  private lastPowerData?: PowerData;
  private lastApiResponse?: any;
  private lastDataFetch?: Date;
  private faultCode?: string | number;
  private faultTimestamp?: Date;

  constructor(
    ip: string,
    serialNumber: string,
    isMaster: boolean,
    info: InverterInfo,
    hostname?: string,
    battery?: BatteryInfo,
    meter?: MeterInfo,
  ) {
    this.ip = ip;
    this.serialNumber = serialNumber;
    this.isMaster = isMaster;
    this.hostname = hostname;
    this.info = info;
    this.battery = battery;
    this.meter = meter;

    // Always create solar integrator
    this.solarIntegrator = new EnergyIntegrator();

    // Create battery integrator if battery exists
    if (battery) {
      this.batteryIntegrator = new BidirectionalEnergyIntegrator();
    }

    // Create grid integrator only for master
    if (isMaster) {
      this.gridIntegrator = new BidirectionalEnergyIntegrator();
    }
  }

  // Getters
  public getIp(): string {
    return this.ip;
  }
  public getSerialNumber(): string {
    return this.serialNumber;
  }
  public getIsMaster(): boolean {
    return this.isMaster;
  }
  public getHostname(): string | undefined {
    return this.hostname;
  }
  public getInfo(): InverterInfo {
    return this.info;
  }
  public getBattery(): BatteryInfo | undefined {
    return this.battery;
  }
  public getMeter(): MeterInfo | undefined {
    return this.meter;
  }
  public getLastPowerData(): PowerData | undefined {
    return this.lastPowerData;
  }
  public getLastDataFetch(): Date | undefined {
    return this.lastDataFetch;
  }
  public getFaultCode(): string | number | undefined {
    return this.faultCode;
  }
  public getFaultTimestamp(): Date | undefined {
    return this.faultTimestamp;
  }

  // Energy counters
  public getEnergyData(): EnergyData {
    return {
      solarWh: this.solarIntegrator.getTotalKwh() * 1000,
      batteryInWh: this.batteryIntegrator
        ? this.batteryIntegrator.getNegativeKwh() * 1000
        : 0,
      batteryOutWh: this.batteryIntegrator
        ? this.batteryIntegrator.getPositiveKwh() * 1000
        : 0,
      gridInWh: this.gridIntegrator
        ? this.gridIntegrator.getPositiveKwh() * 1000
        : 0,
      gridOutWh: this.gridIntegrator
        ? this.gridIntegrator.getNegativeKwh() * 1000
        : 0,
    };
  }

  // Fetch power flow data from the inverter
  public async fetchPowerFlow(): Promise<PowerData | null> {
    try {
      const response = await axios.get(
        `http://${this.ip}/solar_api/v1/GetPowerFlowRealtimeData.fcgi`,
        {
          timeout: 5000,
        },
      );

      this.lastApiResponse = response.data;
      this.lastDataFetch = new Date();

      const data = response.data;
      if (data?.Body?.Data?.Site) {
        const site = data.Body.Data.Site;
        const inverters = data.Body.Data.Inverters;
        const firstInverter = inverters && (Object.values(inverters)[0] as any);

        // Extract power data
        const powerData: PowerData = {
          timestamp: new Date(),
          solarW:
            site.P_PV !== null && site.P_PV !== undefined
              ? Math.round(site.P_PV)
              : undefined,
          batteryW:
            site.P_Akku !== null && site.P_Akku !== undefined
              ? Math.round(site.P_Akku)
              : undefined,
          gridW:
            site.P_Grid !== null && site.P_Grid !== undefined
              ? Math.round(site.P_Grid)
              : undefined,
          batterySoC:
            firstInverter?.SOC !== null && firstInverter?.SOC !== undefined
              ? firstInverter.SOC
              : undefined,
        };

        this.lastPowerData = powerData;

        // Update integrators
        const now = new Date();
        if (this.solarIntegrator && powerData.solarW !== undefined) {
          this.solarIntegrator.updatePower(powerData.solarW, now);
        }

        if (this.batteryIntegrator && powerData.batteryW !== undefined) {
          this.batteryIntegrator.updatePower(powerData.batteryW, now);
        }

        if (this.gridIntegrator && powerData.gridW !== undefined) {
          this.gridIntegrator.updatePower(powerData.gridW, now);
        }

        // Check for faults
        const statusCode = firstInverter?.DeviceStatus?.StatusCode;
        if (statusCode && statusCode !== 7) {
          this.faultCode = statusCode;
          this.faultTimestamp = new Date();
        } else {
          this.faultCode = undefined;
          this.faultTimestamp = undefined;
        }

        return powerData;
      }

      return null;
    } catch (error: any) {
      // Extract just the error code for cleaner logging
      if (error.code === "ECONNABORTED") {
        console.error(
          `Failed to fetch power flow from ${this.ip}: timeout of 5000ms exceeded: ${error.code}`,
        );
      } else if (error.code) {
        console.error(
          `Failed to fetch power flow from ${this.ip}: ${error.message || error.code}`,
        );
      } else {
        console.error(
          `Failed to fetch power flow from ${this.ip}:`,
          error.message || error,
        );
      }
      return null;
    }
  }

  // Fetch device information (battery, inverter, meter)
  public async fetchDeviceInfo(): Promise<void> {
    // These could be fetched periodically or on demand
    // For now, they're set during construction from discovery
  }

  // Get display name
  public getDisplayName(): string {
    return this.info.customName || this.hostname?.split(".")[0] || this.ip;
  }

  // Reset energy counters
  public resetEnergyCounters(): void {
    this.solarIntegrator.reset();
    this.batteryIntegrator?.reset();
    this.gridIntegrator?.reset();
  }

  // Static methods to fetch device information during discovery
  public static async fetchBatteryInfo(
    ip: string,
  ): Promise<BatteryInfo | undefined> {
    try {
      const response = await axios.get(
        `http://${ip}/solar_api/v1/GetStorageRealtimeData.cgi`,
        {
          timeout: 2000,
        },
      );

      // Check for controller in Data["0"].Controller structure (newer API)
      const controller = response.data?.Body?.Data?.["0"]?.Controller;
      if (controller) {
        return {
          manufacturer: controller.Details?.Manufacturer,
          model: controller.Details?.Model,
          serial: controller.Details?.Serial?.trim(), // Trim whitespace from serial
          capacityWh: controller.Capacity_Maximum,
          enabled: controller.Enable === 1,
        };
      }

      // Fallback to check for controller in Data.Controller[0] structure (older API)
      const altController = response.data?.Body?.Data?.Controller?.[0];
      if (altController) {
        return {
          manufacturer: altController.Details?.Manufacturer,
          model: altController.Details?.Model,
          serial: altController.Details?.Serial?.trim(),
          capacityWh: altController.Capacity_Maximum,
          enabled: altController.Enable === 1,
        };
      }
    } catch (error: any) {
      // No battery or error fetching battery info - this is normal for devices without batteries
    }

    return undefined;
  }

  public static async fetchInverterInfo(
    ip: string,
  ): Promise<InverterInfo | undefined> {
    try {
      const response = await axios.get(
        `http://${ip}/solar_api/v1/GetInverterInfo.cgi`,
        {
          timeout: 2000,
        },
      );

      const inverterData = response.data?.Body?.Data;
      if (inverterData) {
        // Get the first inverter (usually key "1")
        const firstInverter = Object.values(inverterData)[0] as any;
        if (firstInverter) {
          // Map device type to model name
          const deviceType = firstInverter.DT;
          const modelName =
            deviceType && DEVICE_TYPE_MAP[deviceType]
              ? DEVICE_TYPE_MAP[deviceType]
              : firstInverter.Type || `Unknown (DT: ${deviceType})`;

          return {
            manufacturer: "Fronius",
            model: modelName,
            pvPowerW: firstInverter.PVPower || 0,
            customName: firstInverter.CustomName || "",
            serialNumber: firstInverter.UniqueID || "",
          };
        }
      }
    } catch (error) {
      console.log(`Error fetching inverter info from ${ip}:`, error);
    }
    return undefined;
  }

  public static async fetchMeterInfo(
    ip: string,
  ): Promise<MeterInfo | undefined> {
    try {
      const response = await axios.get(
        `http://${ip}/solar_api/v1/GetMeterRealtimeData.cgi?Scope=System`,
        {
          timeout: 2000,
        },
      );

      const meterData = response.data?.Body?.Data;
      if (meterData && Object.keys(meterData).length > 0) {
        // Get the first meter
        const firstMeter = Object.values(meterData)[0] as any;
        if (firstMeter) {
          // Translate meter location codes according to Fronius documentation
          const locationCode = firstMeter.Meter_Location_Current;
          let location = "Unknown";

          if (locationCode === 0) {
            location = "Grid (feed-in point)";
          } else if (locationCode === 1) {
            location = "Load (consumption)";
          } else if (locationCode === 3) {
            location = "External generator";
          } else if (locationCode >= 256 && locationCode <= 511) {
            // Subload range
            const subloadNumber = locationCode - 255;
            location = `Subload #${subloadNumber}`;
          } else if (locationCode >= 512 && locationCode <= 768) {
            // EV Charger range
            const evNumber = locationCode - 511;
            location = `EV Charger #${evNumber}`;
          } else if (locationCode >= 769 && locationCode <= 1023) {
            // Storage range
            const storageNumber = locationCode - 768;
            location = `Storage #${storageNumber}`;
          }

          // Check for Continental Control Systems meters
          let manufacturer = firstMeter.Details?.Manufacturer || "Unknown";
          const model =
            firstMeter.Details?.Model || firstMeter.Details?.Type || "Unknown";

          if (model && model.startsWith("CCS")) {
            manufacturer = "Continental Control Systems";
          }

          return {
            manufacturer,
            model,
            serial: firstMeter.Details?.Serial?.trim(),
            location,
            enabled: firstMeter.Enable === 1 || firstMeter.Enabled === 1,
          };
        }
      }
    } catch (error) {
      // No meter or error fetching meter info
    }
    return undefined;
  }
}
