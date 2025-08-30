// Type definitions for Selectronic inverter data

export type SelectronicData = {
  solarW: number;           // Total solar (solarinverter_w + shunt_w) in Watts
  solarInverterW: number;   // Remote solar generation in Watts
  shuntW: number;           // Local solar generation in Watts
  loadW: number;            // Load in Watts
  batterySOC: number;
  batteryW: number;         // Battery power in Watts (negative = charging)
  gridW: number;            // Grid power in Watts
  faultCode: number;
  faultTimestamp: number;   // Unix timestamp
  generatorStatus: number;
  // Energy totals (kWh despite the _wh_ in API names)
  solarKwhTotal: number;
  loadKwhTotal: number;
  batteryInKwhTotal: number;
  batteryOutKwhTotal: number;
  gridInKwhTotal: number;
  gridOutKwhTotal: number;
  // Daily energy (kWh despite the _wh_ in API names)
  solarKwhToday: number;
  loadKwhToday: number;
  batteryInKwhToday: number;
  batteryOutKwhToday: number;
  gridInKwhToday: number;
  gridOutKwhToday: number;
  timestamp: Date;
  raw?: Record<string, any>;
};

export type ApiResponse<T> = {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: Date;
};