// Configuration for LiveOne

// Error Messages
export const ERROR_MESSAGES = {
  AUTH_FAILED: "Authentication failed. Please check credentials.",
  SESSION_EXPIRED: "Session expired. Re-authenticating...",
  API_UNAVAILABLE: "Select.live API is currently unavailable.",
  MAGIC_WINDOW:
    "API unavailable during magic window (48-52 minutes past hour).",
  NETWORK_ERROR: "Network error. Please check your connection.",
  INVALID_RESPONSE: "Invalid response from API.",
  SYSTEM_NOT_FOUND: "System number not found.",
  RATE_LIMITED: "Rate limited. Please try again later.",
} as const;
