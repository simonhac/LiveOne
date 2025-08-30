// Configuration for LiveOne

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

// Polling Configuration
export const POLLING_CONFIG = {
  defaultInterval: 60000,             // Default 1 minute polling
  minInterval: 30000,                 // Minimum 30 seconds
  maxInterval: 300000,                // Maximum 5 minutes
  magicWindowStart: 48,               // Magic window starts at minute 48
  magicWindowEnd: 52,                 // Magic window ends at minute 52
  retryOnErrorDelay: 5000,            // Wait 5 seconds after error
} as const;

// Import real secrets from separate file (optional in production)
let LIVEONE_USERS: any = {};
let SELECTLIVE_CREDENTIALS: any = {};

try {
  const secrets = require('./USER_SECRETS');
  LIVEONE_USERS = secrets.LIVEONE_USERS || {};
  SELECTLIVE_CREDENTIALS = secrets.SELECTLIVE_CREDENTIALS || {};
} catch (error) {
  // USER_SECRETS not available (production environment)
  console.log('[Config] USER_SECRETS not found, using environment variables');
}

// All users configuration (legacy - for old login route)
export const APP_USERS = LIVEONE_USERS;

// Select.Live API Configuration (legacy - credentials now in Clerk)
export const SELECTLIVE_CONFIG = {
  username: SELECTLIVE_CREDENTIALS.username || process.env.SELECTRONIC_EMAIL || '',
  password: SELECTLIVE_CREDENTIALS.password || process.env.SELECTRONIC_PASSWORD || '',
  systemNumber: SELECTLIVE_CREDENTIALS.systemNumber || process.env.SELECTRONIC_SYSTEM || '',
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

