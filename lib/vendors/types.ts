import type { CommonPollingData } from "@/lib/types/common";
import type { LatestReadingData } from "@/lib/types/readings";
import type { ZonedDateTime } from "@internationalized/date";
import type { SystemWithPolling } from "@/lib/systems-manager";

/**
 * Field definition for credential requirements
 */
export interface CredentialField {
  name: string;
  label: string;
  type: "text" | "email" | "password" | "url" | "number";
  placeholder?: string;
  required?: boolean;
  helpText?: string;
}

/**
 * Vendor adapter interface for all energy system vendors
 */
export interface VendorAdapter {
  // Basic vendor information
  readonly vendorType: string;
  readonly displayName: string;
  readonly dataSource: "poll" | "push" | "combined";
  readonly dataStore: "readings" | "point_readings"; // Where data is stored

  // Credential requirements for this vendor
  readonly credentialFields?: CredentialField[];
  readonly supportsAddSystem?: boolean; // Whether this vendor supports the Add System flow

  // Check if system should be polled based on schedule
  shouldPoll(
    system: SystemWithPolling,
    force: boolean,
    now: Date,
  ): Promise<{
    shouldPoll: boolean;
    reason?: string;
    nextPoll?: ZonedDateTime;
  }>;

  // Main polling function - handles all data collection
  poll(
    system: SystemWithPolling,
    credentials: any,
    force: boolean,
    now: Date,
    sessionId: number,
  ): Promise<PollingResult>;

  // Get the latest reading for this system
  getLastReading(systemId: number): Promise<LatestReadingData | null>;

  // Test connection with vendor
  testConnection(
    system: SystemWithPolling,
    credentials: any,
  ): Promise<TestConnectionResult>;

  // Get all possible capabilities for this system (what it could support)
  // Returns array of capability strings in format: type.subtype.extension (subtype and extension optional)
  getPossibleCapabilities(systemId: number): Promise<string[]>;

  // Get enabled capabilities for this system (what is currently enabled)
  // Returns array of capability strings in format: type.subtype.extension (subtype and extension optional)
  getEnabledCapabilities(systemId: number): Promise<string[]>;
}

/**
 * Capability definition
 */
export interface Capability {
  type: string;
  subtype: string | null;
  extension: string | null;
}

/**
 * Result from a polling operation
 * Also used for cron API responses (with additional fields populated by the cron route)
 */
export interface PollingResult {
  action: "POLLED" | "SKIPPED" | "ERROR";
  data?: CommonPollingData | CommonPollingData[]; // The transformed data
  rawResponse?: any; // Raw vendor response for storage
  recordsProcessed?: number; // For POLLED
  reason?: string; // For SKIPPED or ERROR
  error?: string; // For ERROR
  errorCode?: string; // HTTP status code or other error code for ERROR
  nextPoll?: ZonedDateTime; // When to poll next

  // Additional fields for cron API responses (populated by cron route, not adapters)
  systemId?: number;
  displayName?: string;
  vendorType?: string;
  sessionLabel?: string;
  lastPoll?: string | null;
  durationMs?: number; // Elapsed time for the poll operation in milliseconds
}

/**
 * Result from testing a connection
 */
export interface TestConnectionResult {
  success: boolean;
  systemInfo?: {
    vendorSiteId?: string; // Discovered vendor site ID
    displayName?: string; // Suggested display name
    model?: string | null;
    serial?: string | null;
    ratings?: string | null;
    solarSize?: string | null;
    batterySize?: string | null;
  };
  latestData?: CommonPollingData;
  vendorResponse?: any; // Raw vendor response for debugging
  error?: string;
  errorCode?: string; // HTTP status code or other error code
}
