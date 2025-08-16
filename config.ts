// Configuration for LiveOne - Selectronic to MQTT Bridge

// API Configuration
export const API_CONFIG = {
  baseUrl: 'https://select.live',
  loginEndpoint: '/login',
  loginPageEndpoint: '/login',
  dataEndpoint: '/dashboard/hfdata',
  timeout: 30000,                    // 30 seconds timeout
  retryAttempts: 3,                   // Number of retry attempts
  retryDelay: 1000,                   // Initial retry delay in ms
} as const;

// Server Request Queue Configuration
export const SERVER_REQUEST_QUEUE_CONFIG = {
  maxConcurrent: 10,                  // Max parallel requests
  minInterval: 100,                   // Minimum 100ms between requests
  rateLimitWindow: 60000,             // Rate limit window (1 minute)
  maxRequestsPerWindow: 60,           // Max requests per minute
} as const;

// Session Configuration
export const SESSION_CONFIG = {
  sessionTimeout: 30 * 60 * 1000,     // 30 minutes session timeout
  refreshThreshold: 5 * 60 * 1000,    // Refresh when 5 minutes remaining
  cookieName: 'select-live-session',
  sessionCheckInterval: 60000,        // Check session every minute
} as const;

// Polling Configuration
export const POLLING_CONFIG = {
  defaultInterval: 60000,             // Default 1 minute polling
  minInterval: 30000,                 // Minimum 30 seconds
  maxInterval: 300000,                // Maximum 5 minutes
  magicWindowStart: 48,               // Magic window starts at minute 48
  magicWindowEnd: 52,                 // Magic window ends at minute 52
  retryOnErrorDelay: 5000,            // Wait 5 seconds after error
} as const;

// Cache Configuration
export const CACHE_CONFIG = {
  defaultTTL: 60000,                  // Default cache TTL (1 minute)
  maxCacheSize: 100,                  // Max number of cached items
  staleWhileRevalidate: true,         // Serve stale while fetching fresh
  cacheKeyPrefix: 'liveone:',
} as const;

// Import real secrets from separate file
import { LIVEONE_USERS, SELECTLIVE_CREDENTIALS, USER_TO_SYSTEM } from './USER_SECRETS';

// All users configuration
export const APP_USERS = LIVEONE_USERS;

// User to system mapping - re-export from USER_SECRETS
export { USER_TO_SYSTEM };

// Select.Live API Configuration (for fetching inverter data)
export const SELECTLIVE_CONFIG = {
  username: SELECTLIVE_CREDENTIALS.username,
  password: SELECTLIVE_CREDENTIALS.password,
  systemNumber: SELECTLIVE_CREDENTIALS.systemNumber,
} as const;

// MQTT Configuration (for future use)
export const MQTT_CONFIG = {
  brokerUrl: process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883',
  username: process.env.MQTT_USERNAME || '',
  password: process.env.MQTT_PASSWORD || '',
  clientId: `liveone-${Date.now()}`,
  topicPrefix: 'liveone',
  qos: 1,                             // QoS level for publishing
  retain: true,                       // Retain messages
  connectTimeout: 30000,              // Connection timeout
} as const;

// Application Configuration
export const APP_CONFIG = {
  appName: 'LiveOne',
  appVersion: '0.1.0',
  environment: process.env.NODE_ENV || 'development',
  port: process.env.PORT || 3000,
  logLevel: process.env.LOG_LEVEL || 'info',
  timezone: 'Australia/Sydney',
} as const;

// Data Field Mappings
export const DATA_FIELD_MAPPINGS = {
  solarinverter_w: 'solarPower',
  load_w: 'loadPower',
  battery_soc: 'batterySOC',
  battery_w: 'batteryPower',
  battery_v: 'batteryVoltage',
  grid_w: 'gridPower',
  grid_v: 'gridVoltage',
  grid_hz: 'gridFrequency',
  inverter_temp: 'inverterTemperature',
  inverter_mode: 'inverterMode',
  solar_v: 'solarVoltage',
  solar_a: 'solarCurrent',
} as const;

// Error Messages
export const ERROR_MESSAGES = {
  AUTH_FAILED: 'Authentication failed. Please check credentials.',
  SESSION_EXPIRED: 'Session expired. Re-authenticating...',
  API_UNAVAILABLE: 'Select.live API is currently unavailable.',
  MAGIC_WINDOW: 'API unavailable during magic window (48-52 minutes past hour).',
  NETWORK_ERROR: 'Network error. Please check your connection.',
  INVALID_RESPONSE: 'Invalid response from API.',
  SYSTEM_NOT_FOUND: 'System number not found.',
  RATE_LIMITED: 'Rate limited. Please try again later.',
} as const;

// Development Configuration
export const DEV_CONFIG = {
  enableDebugLogging: process.env.NODE_ENV === 'development',
  mockApiResponses: process.env.MOCK_API === 'true',
  logApiCalls: true,
  logResponseData: false,              // Set to true to log full responses
  useLocalStorage: true,               // Use localStorage for session in dev
} as const;

// Database Configuration
export const DATABASE_CONFIG = {
  // Use SQLite in development, Turso/PostgreSQL in production
  url: process.env.DATABASE_URL || 'file:./dev.db',
  
  // Turso config (for production)
  turso: {
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
  
  // Data retention settings
  retention: {
    rawDataDays: 30,                   // Keep raw data for 30 days
    aggregatedDataDays: 365,           // Keep hourly/daily aggregates for 1 year
  },
  
  // Performance settings
  performance: {
    batchSize: 100,                    // Batch insert size
    maxConnections: 10,                // Max DB connections
  },
} as const;

// Export type for TypeScript
export type SelectronicData = {
  solarPower: number;           // Total solar (solarinverter_w + shunt_w)
  solarInverterPower: number;   // Remote solar generation
  shuntPower: number;           // Local solar generation
  loadPower: number;
  batterySOC: number;
  batteryPower: number;
  gridPower: number;
  faultCode: number;
  faultTimestamp: number;       // Unix timestamp
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