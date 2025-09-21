/**
 * Common types shared across different vendor integrations
 */

/**
 * Normalized polling data format used by all vendor types
 * This is the common structure that gets stored in the database
 */
export interface CommonPollingData {
  // Timestamp
  timestamp: string;
  
  // Power readings (Watts) - instantaneous values
  solarW?: number | null;        // Total solar (solarLocalW + solarRemoteW)
  solarLocalW?: number | null;   // Local solar from shunt/CT
  solarRemoteW?: number | null;  // Remote solar from inverter
  loadW?: number | null;
  batteryW?: number | null;
  gridW?: number | null;
  
  // Battery state
  batterySOC?: number | null;  // State of charge (0-100%)
  
  // System status
  faultCode?: string | null;
  faultTimestamp?: number | null;  // Unix timestamp of fault
  generatorStatus?: number | null;
  
  // Energy counters (Wh) - interval values (energy in this period)
  solarWhInterval?: number | null;
  loadWhInterval?: number | null;
  batteryInWhInterval?: number | null;
  batteryOutWhInterval?: number | null;
  gridInWhInterval?: number | null;
  gridOutWhInterval?: number | null;
  
  // Energy counters (kWh) - lifetime totals
  solarKwhTotal?: number | null;
  loadKwhTotal?: number | null;
  batteryInKwhTotal?: number | null;
  batteryOutKwhTotal?: number | null;
  gridInKwhTotal?: number | null;
  gridOutKwhTotal?: number | null;
}