import EventEmitter from "events";
import crypto from "crypto";
import axios from "axios";
import { Inverter, PowerData } from "./inverter";
import { InverterInfo, BatteryInfo, MeterInfo, FroniusMinutely } from "./types";
import { formatLocalDateTime } from "../../lib/date-utils";

/**
 * One inverter's connection config (from usher.yaml). `isMaster` is auto-detected (by the presence
 * of Site P_Load in the power-flow response) when omitted. Discovery is NOT done here — over the
 * WireGuard tunnel there's no LAN to ARP-scan; inverters are addressed by explicit host. (The ARP
 * discovery helper lives in tools/discover-fronius.ts as an occasional on-LAN setup CLI.)
 */
export interface FroniusInverterConfig {
  host: string;
  isMaster?: boolean;
}

interface FroniusDevice {
  ip: string;
  hostname?: string;
  isMaster: boolean;
  serialNumber: string;
  battery?: BatteryInfo;
  inverterInfo?: InverterInfo;
  meter?: MeterInfo;
}

export class Site extends EventEmitter {
  private name: string;
  private inverters: Map<string, Inverter> = new Map();
  private devices: Map<string, FroniusDevice> = new Map(); // static device info, keyed by serial
  private inverterConfigs: FroniusInverterConfig[];
  private log: (m: string) => void;

  // Energy tracking
  private sessionId: string; // Base64-encoded 24-bit random number (4 chars)
  private sequenceNumber: number = 0;
  private lastEnergySnapshot: Map<string, any> = new Map();
  private froniusMinutelyHistory: FroniusMinutely[] = [];
  private siteMetricsHistory: any[] = []; // Store last 10 minutes of siteMetrics
  private lastSiteMetrics: any = null;

  // Polling / configuration state
  private pollingInterval: NodeJS.Timeout | null = null;
  private isConfiguring: boolean = false;
  private configured: boolean = false;

  constructor(
    name: string,
    inverterConfigs: FroniusInverterConfig[] = [],
    log?: (m: string) => void,
  ) {
    super();
    this.name = name;
    this.inverterConfigs = inverterConfigs;
    this.log = log ?? (() => {});

    // Generate a 24-bit random number (3 bytes) and encode as base64 (4 chars) for the sequence id.
    const randomBytes = crypto.randomBytes(3);
    this.sessionId = randomBytes.toString("base64");
  }

  // Start the internal fast poll loop (default 2 s). Keeps power/SOC fresh and the energy
  // integrators warm and emits `siteMetrics` for the live dashboard; it does NOT push. The usher's
  // run-loop harvests a minutely report once per minute via generateFroniusMinutely() (poll ≠ push).
  public startPolling(intervalMs: number = 2000): void {
    if (this.pollingInterval) {
      return;
    }

    const tick = () => {
      // Self-heal: if we have no inverters yet (e.g. the tunnel wasn't up at startup, or a config
      // probe failed), (re)configure instead of polling. configureInverters() guards re-entry.
      if (this.inverters.size === 0) {
        if (!this.isConfiguring) void this.configureInverters();
        return;
      }
      void this.pollAllInverters();
    };

    this.pollingInterval = setInterval(tick, intervalMs);
    tick(); // kick immediately
  }

  // Stop polling
  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  }

  // Poll all inverters
  private async pollAllInverters(): Promise<void> {
    const promises = Array.from(this.inverters.values()).map((inverter) =>
      this.pollInverter(inverter),
    );

    await Promise.allSettled(promises);

    // Build site metrics event with site and device data
    const siteMetrics: any = {
      timestamp: formatLocalDateTime(new Date()),
    };

    // Aggregate site-level data - use null if no devices report data
    let siteSolarW: number | null = null;
    let siteSolarWh: number | null = null;
    let siteBatteryW: number | null = null;
    let siteBatteryInWh: number | null = null;
    let siteBatteryOutWh: number | null = null;
    let siteGridW: number | null = null;
    let siteGridInWh: number | null = null;
    let siteGridOutWh: number | null = null;
    let siteLoadW: number | null = null;
    let siteLoadWh: number | null = null;
    let batterySoCs: number[] = [];

    // Track whether we have any data
    let hasSolarData = false;
    let hasBatteryData = false;
    let hasGridData = false;

    // Collect data from each inverter
    this.inverters.forEach((inverter, serialNumber) => {
      const powerData = inverter.getLastPowerData();
      const energyData = inverter.getEnergyData();

      if (powerData) {
        const deviceData: any = {};

        // Solar data
        if (powerData.solarW !== undefined) {
          deviceData.solar = {
            powerW: powerData.solarW,
            energyWh: Math.round(energyData.solarWh),
          };
          if (!hasSolarData) {
            siteSolarW = 0;
            siteSolarWh = 0;
            hasSolarData = true;
          }
          siteSolarW! += powerData.solarW;
          siteSolarWh! += energyData.solarWh;
        }

        // Battery data
        if (powerData.batteryW !== undefined) {
          deviceData.battery = {
            powerW: powerData.batteryW,
            energyInWh: Math.round(energyData.batteryInWh),
            energyOutWh: Math.round(energyData.batteryOutWh),
            soc: powerData.batterySoC,
          };
          if (!hasBatteryData) {
            siteBatteryW = 0;
            siteBatteryInWh = 0;
            siteBatteryOutWh = 0;
            hasBatteryData = true;
          }
          siteBatteryW! += powerData.batteryW;
          siteBatteryInWh! += energyData.batteryInWh;
          siteBatteryOutWh! += energyData.batteryOutWh;
          if (powerData.batterySoC !== undefined) {
            batterySoCs.push(powerData.batterySoC);
          }
        }

        // Grid data (only from master)
        if (inverter.getIsMaster() && powerData.gridW !== undefined) {
          siteGridW = powerData.gridW;
          siteGridInWh = energyData.gridInWh;
          siteGridOutWh = energyData.gridOutWh;
          hasGridData = true;
        }

        // Add device data if it has any measurements
        if (Object.keys(deviceData).length > 0) {
          siteMetrics[serialNumber] = deviceData;
        }
      }
    });

    // Calculate load only if we have the necessary data
    if (hasSolarData || hasGridData || hasBatteryData) {
      siteLoadW = Math.max(
        0,
        (siteSolarW || 0) + (siteGridW || 0) + (siteBatteryW || 0),
      );
    }
    // Calculate load energy from the energy balance equation
    if (hasSolarData || hasGridData || hasBatteryData) {
      // Load = Solar + GridIn + BatteryOut - GridOut - BatteryIn
      siteLoadWh =
        (siteSolarWh || 0) +
        (siteGridInWh || 0) +
        (siteBatteryOutWh || 0) -
        (siteGridOutWh || 0) -
        (siteBatteryInWh || 0);
      siteLoadWh = Math.max(0, siteLoadWh);
      // Only set to null if we truly have no data
      if (
        siteLoadWh === 0 &&
        !hasSolarData &&
        !hasGridData &&
        !hasBatteryData
      ) {
        siteLoadWh = null;
      }
    }

    // Add site-level data
    siteMetrics.site = {
      solar: {
        powerW: siteSolarW,
        energyWh: siteSolarWh !== null ? Math.round(siteSolarWh) : null,
      },
      battery: {
        powerW: siteBatteryW,
        energyInWh:
          siteBatteryInWh !== null ? Math.round(siteBatteryInWh) : null,
        energyOutWh:
          siteBatteryOutWh !== null ? Math.round(siteBatteryOutWh) : null,
        soc:
          batterySoCs.length > 0
            ? batterySoCs.reduce((a, b) => a + b, 0) / batterySoCs.length
            : null,
      },
      grid: {
        powerW: siteGridW,
        energyInWh: siteGridInWh !== null ? Math.round(siteGridInWh) : null,
        energyOutWh: siteGridOutWh !== null ? Math.round(siteGridOutWh) : null,
      },
      load: {
        powerW: siteLoadW,
        energyWh: siteLoadWh !== null ? Math.round(siteLoadWh) : null,
      },
    };

    // Store and emit the site metrics
    this.lastSiteMetrics = siteMetrics;

    // Add to history and keep only last 10 minutes
    this.siteMetricsHistory.push(siteMetrics);
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    this.siteMetricsHistory = this.siteMetricsHistory.filter(
      (metrics) => new Date(metrics.timestamp) >= tenMinutesAgo,
    );

    this.emit("siteMetrics", siteMetrics);
  }

  // Poll a single inverter
  private async pollInverter(inverter: Inverter): Promise<void> {
    const powerData = await inverter.fetchPowerFlow();
    const serialNumber = inverter.getSerialNumber();

    // Emit heartbeat event for this inverter
    this.emit("inverterHeartbeat", {
      serialNumber,
      status: powerData ? "online" : "offline",
      timestamp: new Date(),
    });
  }

  // Configure inverters from the static config (replaces LAN ARP discovery — see FroniusInverterConfig).
  // For each host: fetch device info (battery/inverter/meter), determine master/slave (config, else by
  // Site P_Load presence), and build an Inverter. Called once at startup; safe to re-call.
  public async configureInverters(): Promise<void> {
    if (this.isConfiguring) return;
    this.isConfiguring = true;
    try {
      this.inverters.clear();
      this.devices.clear();

      for (const cfg of this.inverterConfigs) {
        const host = cfg.host;
        this.log(`configuring inverter ${host}…`);

        // Master/slave: honour config, else probe for the presence of Site P_Load.
        const isMaster =
          cfg.isMaster ?? (await Site.probeIsMaster(host, this.log));

        // Fetch static device info once (as the original did during discovery).
        const [batteryInfo, inverterInfo, meterInfo] = await Promise.all([
          Inverter.fetchBatteryInfo(host),
          Inverter.fetchInverterInfo(host),
          Inverter.fetchMeterInfo(host),
        ]);

        const serialNumber =
          inverterInfo?.serialNumber && inverterInfo.serialNumber.length > 0
            ? inverterInfo.serialNumber
            : `UNKNOWN_${host}`;

        const inverterInfoForConstructor: InverterInfo = inverterInfo ?? {
          manufacturer: "Fronius",
          model: "Unknown",
          pvPowerW: 0,
          customName: "",
          serialNumber,
        };

        this.devices.set(serialNumber, {
          ip: host,
          isMaster,
          serialNumber,
          battery: batteryInfo,
          inverterInfo,
          meter: meterInfo,
        });

        const inverter = new Inverter(
          host,
          serialNumber,
          isMaster,
          inverterInfoForConstructor,
          undefined,
          batteryInfo,
          meterInfo,
        );
        this.inverters.set(serialNumber, inverter);

        this.log(
          `added ${isMaster ? "MASTER" : "slave"} inverter ${inverter.getDisplayName()} (${serialNumber})` +
            (batteryInfo
              ? `, battery ${((batteryInfo.capacityWh || 0) / 1000).toFixed(1)}kWh`
              : ""),
        );
      }

      this.configured = true;
      this.emit("siteUpdate", this.getSiteData());
    } catch (error) {
      this.log(
        `configure failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.isConfiguring = false;
    }
  }

  /** Probe whether a Fronius host is the site master (only the master reports Site P_Load). */
  private static async probeIsMaster(
    host: string,
    log: (m: string) => void,
  ): Promise<boolean> {
    try {
      const res = await axios.get(
        `http://${host}/solar_api/v1/GetPowerFlowRealtimeData.fcgi`,
        { timeout: 3000 },
      );
      const pLoad = res.data?.Body?.Data?.Site?.P_Load;
      return pLoad !== undefined && pLoad !== null;
    } catch (e) {
      log(
        `master probe failed for ${host}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
  }

  // Calculate total solar power
  public getTotalSolarPowerW(): number | null {
    if (this.inverters.size === 0) return null;

    let total = 0;
    for (const inverter of this.inverters.values()) {
      const powerData = inverter.getLastPowerData();
      if (powerData?.solarW !== undefined) {
        total += powerData.solarW;
      }
    }
    return total;
  }

  // Calculate total battery power
  public getTotalBatteryPowerW(): number | null {
    if (this.inverters.size === 0) return null;

    let total = 0;
    for (const inverter of this.inverters.values()) {
      const powerData = inverter.getLastPowerData();
      if (powerData?.batteryW !== undefined) {
        total += powerData.batteryW;
      }
    }
    return total;
  }

  // Calculate total grid power (from master only)
  public getTotalGridPowerW(): number | null {
    for (const inverter of this.inverters.values()) {
      if (inverter.getIsMaster()) {
        const powerData = inverter.getLastPowerData();
        return powerData?.gridW ?? null;
      }
    }
    return null;
  }

  // Calculate load power from energy balance
  public calculateLoadPowerW(): number | null {
    if (this.inverters.size === 0) {
      return null;
    }

    let totalSolar = 0;
    let totalBatteryPower = 0;
    let totalGridPower = 0;
    let hasData = false;

    for (const inverter of this.inverters.values()) {
      const powerData = inverter.getLastPowerData();
      if (powerData) {
        if (powerData.solarW !== undefined) {
          totalSolar += powerData.solarW;
          hasData = true;
        }

        if (powerData.batteryW !== undefined) {
          totalBatteryPower += powerData.batteryW;
          hasData = true;
        }

        if (inverter.getIsMaster() && powerData.gridW !== undefined) {
          totalGridPower = powerData.gridW;
          hasData = true;
        }
      }
    }

    if (!hasData) {
      return null;
    }

    // Load = Solar + Grid (positive = import) + Battery (positive = discharge)
    const load = totalSolar + totalGridPower + totalBatteryPower;
    return Math.max(0, Math.round(load));
  }

  // Get battery SOC
  public getBatterySOC(): number | null {
    const socValues: number[] = [];

    for (const inverter of this.inverters.values()) {
      const powerData = inverter.getLastPowerData();
      if (powerData?.batterySoC !== undefined) {
        socValues.push(powerData.batterySoC);
      }
    }

    if (socValues.length === 0) return null;

    // Return average SOC
    return socValues.reduce((sum, soc) => sum + soc, 0) / socValues.length;
  }

  // Get energy totals
  public getEnergyTotals(): {
    solarWh: number | null;
    batteryInWh: number | null;
    batteryOutWh: number | null;
    gridInWh: number | null;
    gridOutWh: number | null;
    loadWh: number | null;
  } {
    if (this.inverters.size === 0) {
      return {
        solarWh: null,
        batteryInWh: null,
        batteryOutWh: null,
        gridInWh: null,
        gridOutWh: null,
        loadWh: null,
      };
    }

    let totals = {
      solarWh: 0,
      batteryInWh: 0,
      batteryOutWh: 0,
      gridInWh: 0,
      gridOutWh: 0,
      loadWh: 0,
    };

    let hasSolar = false;
    let hasBattery = false;
    let hasGrid = false;

    for (const inverter of this.inverters.values()) {
      const energyData = inverter.getEnergyData();

      if (energyData.solarWh > 0) {
        totals.solarWh += energyData.solarWh;
        hasSolar = true;
      }

      if (energyData.batteryInWh > 0 || energyData.batteryOutWh > 0) {
        totals.batteryInWh += energyData.batteryInWh;
        totals.batteryOutWh += energyData.batteryOutWh;
        hasBattery = true;
      }

      if (
        inverter.getIsMaster() &&
        (energyData.gridInWh > 0 || energyData.gridOutWh > 0)
      ) {
        totals.gridInWh += energyData.gridInWh;
        totals.gridOutWh += energyData.gridOutWh;
        hasGrid = true;
      }
    }

    const hasLoad = hasSolar || hasGrid || hasBattery;
    if (hasLoad) {
      totals.loadWh =
        totals.solarWh +
        totals.gridInWh +
        totals.batteryOutWh -
        totals.gridOutWh -
        totals.batteryInWh;
      totals.loadWh = Math.max(0, totals.loadWh);
    }

    return {
      solarWh: hasSolar ? totals.solarWh : null,
      batteryInWh: hasBattery ? totals.batteryInWh : null,
      batteryOutWh: hasBattery ? totals.batteryOutWh : null,
      gridInWh: hasGrid ? totals.gridInWh : null,
      gridOutWh: hasGrid ? totals.gridOutWh : null,
      loadWh: hasLoad ? totals.loadWh : null,
    };
  }

  // Get site data for frontend
  public getSiteData(): any {
    const devices = Array.from(this.inverters.values()).map((inverter) => {
      const energyData = inverter.getEnergyData();
      const powerData = inverter.getLastPowerData();
      const cachedDevice = this.devices.get(inverter.getSerialNumber());

      return {
        ip: inverter.getIp(),
        hostname: inverter.getHostname(),
        serialNumber: inverter.getSerialNumber(),
        isMaster: inverter.getIsMaster(),
        name: inverter.getDisplayName(),
        info: {
          inverter: inverter.getInfo(),
          battery: inverter.getBattery(),
          meter: inverter.getMeter(),
        },
        lastDataFetch: inverter.getLastDataFetch(),
        energyCounters: {
          solarWh: energyData.solarWh,
          batteryInWh: energyData.batteryInWh,
          batteryOutWh: energyData.batteryOutWh,
          gridInWh: energyData.gridInWh,
          gridOutWh: energyData.gridOutWh,
          loadWh: null, // Load is calculated at site level only
        },
      };
    });

    return {
      name: this.name,
      devices: devices,
      siteMetrics: this.lastSiteMetrics,
      hasFault: this.hasFault(),
      faults: this.getFaults(),
    };
  }

  // Check for faults
  public hasFault(): boolean {
    for (const inverter of this.inverters.values()) {
      if (inverter.getFaultCode() !== undefined) {
        return true;
      }
    }
    return false;
  }

  // Get faults
  public getFaults(): Array<{
    serialNumber: string;
    faultCode: string | number;
    timestamp?: Date;
  }> {
    const faults: Array<{
      serialNumber: string;
      faultCode: string | number;
      timestamp?: Date;
    }> = [];

    for (const inverter of this.inverters.values()) {
      const faultCode = inverter.getFaultCode();
      if (faultCode) {
        faults.push({
          serialNumber: inverter.getSerialNumber(),
          faultCode: faultCode,
          timestamp: inverter.getFaultTimestamp(),
        });
      }
    }

    return faults;
  }

  // Get historical data (returns siteMetrics history)
  public getHistoricalData(): any[] {
    return this.siteMetricsHistory;
  }

  // Get energy counters
  public getEnergyCounters(serialNumber?: string): any {
    if (serialNumber) {
      const inverter = this.inverters.get(serialNumber);
      if (inverter) {
        const energyData = inverter.getEnergyData();
        return {
          solarWh: energyData.solarWh,
          batteryInWh: energyData.batteryInWh,
          batteryOutWh: energyData.batteryOutWh,
          gridInWh: energyData.gridInWh,
          gridOutWh: energyData.gridOutWh,
          loadWh: 0,
        };
      }
      return null;
    }

    return this.getEnergyTotals();
  }

  // Generate the FroniusMinutely report for the interval since the last call. Harvested once per
  // minute by the usher's run-loop (fusher.read()). Emits `froniusMinutely` for the live dashboard.
  // The FIRST call establishes the energy baseline and returns null (no push that minute).
  public generateFroniusMinutely(): FroniusMinutely | null {
    const energyTotals = this.getEnergyTotals();

    // Don't generate FroniusMinutely if we have no data yet
    if (energyTotals.solarWh === null && energyTotals.gridInWh === null) {
      return null;
    }

    const totalCurrentWh = {
      solarWh: energyTotals.solarWh ?? 0,
      batteryInWh: energyTotals.batteryInWh ?? 0,
      batteryOutWh: energyTotals.batteryOutWh ?? 0,
      gridInWh: energyTotals.gridInWh ?? 0,
      gridOutWh: energyTotals.gridOutWh ?? 0,
      loadWh: energyTotals.loadWh ?? 0,
    };

    const lastSnapshot = this.lastEnergySnapshot.get("total");

    if (!lastSnapshot) {
      this.lastEnergySnapshot.set("total", totalCurrentWh);
      this.lastEnergySnapshot.set("master", { solarWh: 0 });
      this.lastEnergySnapshot.set("slave", { solarWh: 0 });
      return null;
    }

    const delta = {
      solarWh: Math.round(totalCurrentWh.solarWh - (lastSnapshot.solarWh || 0)),
      batteryInWh: Math.round(
        totalCurrentWh.batteryInWh - (lastSnapshot.batteryInWh || 0),
      ),
      batteryOutWh: Math.round(
        totalCurrentWh.batteryOutWh - (lastSnapshot.batteryOutWh || 0),
      ),
      gridInWh: Math.round(
        totalCurrentWh.gridInWh - (lastSnapshot.gridInWh || 0),
      ),
      gridOutWh: Math.round(
        totalCurrentWh.gridOutWh - (lastSnapshot.gridOutWh || 0),
      ),
      loadWh: Math.round(totalCurrentWh.loadWh - (lastSnapshot.loadWh || 0)),
    };

    const nextSnapshot = {
      solarWh: (lastSnapshot.solarWh || 0) + delta.solarWh,
      batteryInWh: (lastSnapshot.batteryInWh || 0) + delta.batteryInWh,
      batteryOutWh: (lastSnapshot.batteryOutWh || 0) + delta.batteryOutWh,
      gridInWh: (lastSnapshot.gridInWh || 0) + delta.gridInWh,
      gridOutWh: (lastSnapshot.gridOutWh || 0) + delta.gridOutWh,
      loadWh: (lastSnapshot.loadWh || 0) + delta.loadWh,
    };

    this.lastEnergySnapshot.set("total", nextSnapshot);

    // Calculate master/slave solar split
    let masterPowerW = 0;
    let slavePowerW = 0;

    for (const inverter of this.inverters.values()) {
      const powerData = inverter.getLastPowerData();
      if (powerData?.solarW) {
        if (inverter.getIsMaster()) {
          masterPowerW += powerData.solarW;
        } else {
          slavePowerW += powerData.solarW;
        }
      }
    }

    const masterSnapshot = this.lastEnergySnapshot.get("master") || {
      solarWh: 0,
    };
    const slaveSnapshot = this.lastEnergySnapshot.get("slave") || {
      solarWh: 0,
    };

    const totalSolarPowerW = masterPowerW + slavePowerW;
    let masterSolarIntervalWh = 0;
    let slaveSolarIntervalWh = 0;

    if (totalSolarPowerW > 0 && delta.solarWh > 0) {
      const masterRatio = masterPowerW / totalSolarPowerW;
      masterSolarIntervalWh = Math.round(delta.solarWh * masterRatio);
      slaveSolarIntervalWh = delta.solarWh - masterSolarIntervalWh;
    }

    this.lastEnergySnapshot.set("master", {
      solarWh: masterSnapshot.solarWh + masterSolarIntervalWh,
    });
    this.lastEnergySnapshot.set("slave", {
      solarWh: slaveSnapshot.solarWh + slaveSolarIntervalWh,
    });

    const faults = this.getFaults();
    let faultCode: string | number | null = null;
    let faultTimestamp: string | null = null;

    if (faults.length > 0) {
      faultCode = faults[0].faultCode;
      faultTimestamp = faults[0].timestamp
        ? formatLocalDateTime(faults[0].timestamp)
        : null;
    }

    const froniusMinutely: FroniusMinutely = {
      timestamp: formatLocalDateTime(new Date()),
      sequence: `${this.sessionId}/${this.sequenceNumber}`,
      solarW: Math.round(totalSolarPowerW),
      solarWhInterval: delta.solarWh,

      solarLocalW: Math.round(masterPowerW),
      solarLocalWhInterval: masterSolarIntervalWh,

      solarRemoteW: Math.round(slavePowerW),
      solarRemoteWhInterval: slaveSolarIntervalWh,

      loadW: Math.round(this.calculateLoadPowerW() || 0),
      loadWhInterval: delta.loadWh,

      batteryW: Math.round(this.getTotalBatteryPowerW() ?? 0),
      batteryInWhInterval: delta.batteryInWh,
      batteryOutWhInterval: delta.batteryOutWh,

      gridW: Math.round(this.getTotalGridPowerW() ?? 0),
      gridInWhInterval: delta.gridInWh,
      gridOutWhInterval: delta.gridOutWh,

      batterySOC:
        this.getBatterySOC() !== null
          ? Math.round(this.getBatterySOC()! * 10) / 10
          : null,

      faultCode: faultCode,
      faultTimestamp: faultTimestamp,

      generatorStatus: null,
    };

    // Increment sequence number after use (post-increment)
    this.sequenceNumber++;

    // Add to history
    this.froniusMinutelyHistory.push(froniusMinutely);

    // Keep only last 20 reports
    if (this.froniusMinutelyHistory.length > 20) {
      this.froniusMinutelyHistory = this.froniusMinutelyHistory.slice(-20);
    }

    // Emit for the live dashboard (the run-loop does the actual push to gusher).
    this.emit("froniusMinutely", froniusMinutely);

    return froniusMinutely;
  }

  // Get FroniusMinutely history
  public getFroniusMinutelyHistory(): FroniusMinutely[] {
    return this.froniusMinutelyHistory;
  }

  // Get site info for SSE
  public getSiteInfo(): any {
    return this.getSiteData();
  }

  // Get the latest site metrics
  public getLatestSiteMetrics(): any {
    return this.lastSiteMetrics;
  }

  // Get inverters
  public getInverters(): Inverter[] {
    return Array.from(this.inverters.values());
  }

  // Get master inverters
  public getMasterInverters(): Inverter[] {
    return this.getInverters().filter((inv) => inv.getIsMaster());
  }

  // Status summary (used by the inspector).
  public getStatus() {
    return {
      deviceCount: this.inverters.size,
      configured: this.configured,
      isConfiguring: this.isConfiguring,
      devices: this.getDevices(),
      site: this.getSiteInfo(),
    };
  }

  public getDevices() {
    return Array.from(this.inverters.values()).map((inverter) => {
      const inverterInfo = inverter.getInfo();
      const battery = inverter.getBattery();
      const meter = inverter.getMeter();
      const lastPowerData = inverter.getLastPowerData();
      const lastDataFetch = inverter.getLastDataFetch();

      return {
        ip: inverter.getIp(),
        serialNumber: inverter.getSerialNumber(),
        name: inverter.getDisplayName(),
        isMaster: inverter.getIsMaster(),
        hostname: inverter.getHostname(),
        info: {
          inverter: inverterInfo,
          battery: battery,
          meter: meter,
        },
        lastUpdated: lastPowerData?.timestamp,
        lastDataFetch: lastDataFetch,
        faultCode: inverter.getFaultCode(),
        faultTimestamp: inverter.getFaultTimestamp(),
      };
    });
  }

  public getFormattedEnergyCounters(serialNumber?: string): any {
    return this.getEnergyCounters(serialNumber);
  }
}
