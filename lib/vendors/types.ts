import type { LatestReadingData } from "@/lib/types/readings";
import type { ZonedDateTime } from "@internationalized/date";
import type { SystemWithPolling } from "@/lib/systems-manager";
import type { PointMetadata } from "@/lib/point/point-manager";
import type { SessionCause } from "@/lib/session-manager";
import type { CommonPollingData } from "@/lib/types/common";

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

// ============================================================================
// Polling Types - Used by base adapter and vendor implementations
// ============================================================================

/**
 * Options passed to poll()
 */
export interface PollOptions {
  forcePollAll: boolean;
  pollReason: string;
  sessionLabel: string; // Full label like "sEfn/3.1"
  sessionCause: SessionCause;
  dryRun?: boolean;
  onSessionStart?: (data: {
    systemId: number;
    sessionId: number;
    sessionLabel: string;
  }) => void; // Called immediately after session is created
  onProgress?: (result: PollingResult) => void; // For live updates during stages
}

/**
 * Context passed to fetchData()
 */
export interface FetchContext {
  startedAt: Date;
  dryRun: boolean;
  session: {
    id: number;
    started: Date;
  };
}

/**
 * What vendors return from fetchData()
 */
export interface FetchResult {
  success: boolean;
  readings?: PointReadingInput[]; // Raw readings
  readingsAgg5m?: PointReadingAgg5mInput[]; // Pre-aggregated (Enphase, Amber)
  recordsProcessed?: number; // For dry-run count
  rawResponse?: any; // For session storage
  nextPollTime?: ZonedDateTime;
  error?: string;
  errorCode?: string;
}

/**
 * Input for raw point readings
 */
export interface PointReadingInput {
  pointMetadata: PointMetadata;
  rawValue: any;
  measurementTime: number; // Unix ms
  dataQuality?: string;
  error?: string | null;
}

/**
 * Input for pre-aggregated 5m readings
 */
export interface PointReadingAgg5mInput {
  pointMetadata: PointMetadata;
  rawValue: any;
  intervalEndMs: number; // Unix ms - end of 5-minute interval
  dataQuality?: string | null;
  error?: string | null;
}

/**
 * Vendor adapter interface for all energy system vendors
 */
export interface VendorAdapter {
  // Basic vendor information
  readonly vendorType: string;
  readonly displayName: string;
  readonly dataSource: "poll" | "push" | "combined";

  // Credential requirements for this vendor
  readonly credentialFields?: CredentialField[];
  readonly supportsAddSystem?: boolean; // Whether this vendor supports the Add System flow

  // Check if system should be polled based on schedule
  shouldPoll(
    system: SystemWithPolling,
    forcePollAll: boolean,
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
    options: PollOptions,
  ): Promise<PollingResult>;

  // Get the latest reading for this system
  getLastReading(systemId: number): Promise<LatestReadingData | null>;

  // Test connection with vendor
  testConnection(
    system: SystemWithPolling,
    credentials: any,
  ): Promise<TestConnectionResult>;
}

/**
 * Stage timing information for Poll All modal
 * - login: Credential fetch (handled by cron route)
 * - fetch: API call to vendor (handled by base adapter)
 * - process: Insert to Turso + publish to QStash (handled by base adapter)
 */
export interface PollStage {
  name: "login" | "fetch" | "process";
  startMs: number; // Absolute timestamp in milliseconds (Date.now())
  endMs: number; // Absolute timestamp in milliseconds (Date.now())
}

/**
 * Result from a polling operation
 * Also used for cron API responses (with additional fields populated by the cron route)
 */
export interface PollingResult {
  action: "POLLED" | "SKIPPED" | "ERROR";
  rawResponse?: any; // Raw vendor response for storage
  recordsProcessed?: number; // For POLLED
  reason?: string; // For SKIPPED or ERROR
  error?: string; // For ERROR
  errorCode?: string; // HTTP status code or other error code for ERROR
  nextPollTimeMs?: number; // When to poll next (Unix timestamp in milliseconds)

  // Additional fields for cron API responses (populated by cron route, not adapters)
  systemId?: number;
  displayName?: string;
  vendorType?: string;
  sessionId?: number; // Database session ID (numeric primary key)
  sessionLabel?: string; // Session label (string identifier)
  lastPoll?: string | null;
  durationMs?: number; // Elapsed time for the poll operation in milliseconds
  startMs?: number; // Start time of this poll (absolute timestamp in milliseconds)
  endMs?: number; // End time of this poll (absolute timestamp in milliseconds)
  stages?: PollStage[]; // Detailed stage timing (login, fetch, process)
  inProgress?: boolean; // True when sending periodic updates during a stage
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
