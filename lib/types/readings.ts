/**
 * Common interface for latest reading data
 * Used by both Selectronic and Enphase systems
 */
export interface LatestReadingData {
  timestamp: Date;
  receivedTime: Date;
  power: {
    solarW: number | null;
    solarLocalW: number | null;
    solarRemoteW: number | null;
    loadW: number | null;
    batteryW: number | null;
    gridW: number | null;
  };
  soc: {
    battery: number | null;
  };
  energy: {
    today: {
      solarKwh: number | null;
      loadKwh: number | null;
      batteryInKwh: number | null;
      batteryOutKwh: number | null;
      gridInKwh: number | null;
      gridOutKwh: number | null;
    };
  };
  system: {
    faultCode: number | null;
    faultTimestamp: number | null;
    generatorStatus: number | null;
  };
}