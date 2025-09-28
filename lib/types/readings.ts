/**
 * Common interface for latest reading data
 * Used by all vendor adapters
 */
export interface LatestReadingData {
  timestamp: Date;
  receivedTime: Date;

  solar: {
    powerW: number | null;
    localW: number | null;
    remoteW: number | null;
  };

  battery: {
    powerW: number | null;
    soc: number | null;
  };

  load: {
    powerW: number | null;
  };

  grid: {
    powerW: number | null;
    generatorStatus: number | null;
  };

  connection: {
    faultCode: string | null;
    faultTimestamp: number | null;
  };
}