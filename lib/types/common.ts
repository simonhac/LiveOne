/**
 * Common types shared across different vendor integrations
 */

/**
 * Normalized polling data format used by all vendor types
 * This is the common structure that gets stored in the database
 */
export interface CommonPollingData {
  timestamp: string;
  solarW: number;
  solarInverterW: number;
  shuntW: number;
  loadW: number;
  batteryW: number;
  gridW: number;
  batterySOC: number;
  faultCode: number;
  faultTimestamp: number;
  generatorStatus: number;
  solarKwhTotal: number;
  loadKwhTotal: number;
  batteryInKwhTotal: number;
  batteryOutKwhTotal: number;
  gridInKwhTotal: number;
  gridOutKwhTotal: number;
}