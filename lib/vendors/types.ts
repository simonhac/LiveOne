import type { LatestReadingData } from "@/lib/types/readings";
import type { ZonedDateTime } from "@internationalized/date";
import type { DeviceConfigView } from "@/lib/registry/device-config";
import type { PointMetadata } from "@/lib/point/point-manager";
import type { SessionCause } from "@/lib/session-manager";
import type { CommonPollingData } from "@/lib/types/common";
import type { PointRow } from "@/lib/db/planetscale/schema";
import type { PointActionName } from "@/lib/control/point-control";
import type { StructuredMessage } from "@/lib/control/message-format";

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
    sessionId: string;
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
    id: string; // UUIDv7 (text); historical = stringified int
    started: Date;
  };
  collector?: import("@/lib/observations/poll-collector").PollCollector;
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
  // NO `nextPollTime`. It is a display value derived purely from the schedule, and letting vendors
  // supply it meant 17 `getNextMinuteBoundary` calls across 6 adapters — plus the
  // `timezoneOffsetMin` plumbing each carried — to restate what the scheduler already knows.
  // `BaseVendorAdapter.nextPollFor` computes it once.
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

// ============================================================================
// Control (command) capability — the write half of a vendor adapter
// ============================================================================

/**
 * One command, addressed at a POINT rather than at a vendor-specific verb. The point's
 * `control` descriptor (`points.control`) has already been validated against the action by
 * the time a capability sees this.
 *
 * There is deliberately NO session/user here: credentials are always resolved from
 * `device.ownerClerkUserId`, so an automation with no session user can dispatch the same way
 * a request can.
 */
export interface ControlInvokeContext {
  device: DeviceConfigView;
  point: PointRow;
  action: PointActionName; // 'turn_on' | 'turn_off' | 'set_value' | 'press'
  value?: number;
}

/**
 * Benign vendor declines are RETURNED (`ok:false` + `reason`, e.g. Tesla's `not_charging`
 * when stopping an idle charge — a 200, never a 500). Infra failures are THROWN
 * (`ControlDispatchError` / `ControlRejectedError` from `lib/control/errors`, or anything
 * else, which the plane treats as unexpected).
 */
export interface ControlInvokeResult {
  ok: boolean;
  reason?: string;
  /**
   * `reason` UNRENDERED, when it names an instant (see `lib/control/message-format.ts`).
   *
   * The flat `reason` remains the AUDIT record — it is what lands in `point_commands.vendorResult`,
   * so it must stay a complete sentence on its own and must not depend on a reader. Emit the instant
   * there in ISO form and put the template here; the dialog prefers this, the audit trail keeps the
   * unambiguous instant, and neither has to know about the other.
   */
  reasonMessage?: StructuredMessage;
}

/**
 * A READ-ONLY answer to "what would happen if I commanded this point right now" — the write half's
 * dry run. Optional on the capability: only a vendor whose hardware can be *interrogated* without
 * being *moved* can honestly provide one.
 *
 * Why this is not just another action: a preflight writes nothing, so it takes no `point_commands`
 * audit row and never goes through `dispatchPointAction`. It is a read, and it is gated exactly like
 * `POST /api/v4/points/{pt_}/refresh` — owner-only, because it spends a round trip to someone's
 * hardware.
 *
 * 🛑 `checks` and `verdict` come from the VENDOR, and callers must render them rather than
 * re-deriving an opinion. For DeepSea the verdict is produced by the very same `gateStart()` the
 * real request path consults, which is the only reason a UI may trust it as a gate — a
 * client-side reimplementation would be free to drift into a comforting lie.
 */
export interface ControlPreflightResult {
  /** False ⇒ we could not complete the probe at all (hardware unreachable); `verdict` says why. */
  ok: boolean;
  /** Would a command be ACCEPTED right now? Undefined when `ok` is false. */
  wouldProceed?: boolean;
  /** One human sentence, from the vendor. Always present, including on failure. */
  verdict: string;
  /**
   * `verdict` UNRENDERED, when it names an instant a hub had no locale to spell (see
   * `lib/control/message-format.ts`). Optional and additive: `verdict` is always populated, so a
   * renderer may prefer this and fall back without branching, and a vendor that never emits an
   * instant simply never sets it.
   */
  verdictMessage?: StructuredMessage;
  /** Named facts the probe read, in display order. Rendered as a checklist. */
  checks?: ControlPreflightCheck[];
  /** Vendor-specific extras the caller understands (DeepSea: the hub's `ControlStatus`). */
  detail?: unknown;
}

export interface ControlPreflightCheck {
  /** Short label, e.g. "Panel mode". */
  label: string;
  /** The value read, in words, e.g. "Auto". */
  value: string;
  /** Does this fact permit a command? `null` ⇒ informational, neither pass nor fail. */
  ok: boolean | null;
}

export interface ControlCapability {
  invoke(ctx: ControlInvokeContext): Promise<ControlInvokeResult>;
  /**
   * Optional read-only dry run (see `ControlPreflightResult`). Absent ⇒ the preflight route answers
   * 501, which is the correct answer for a vendor that cannot be asked without being poked.
   */
  preflight?(ctx: ControlPreflightContext): Promise<ControlPreflightResult>;
}

/** A preflight names a point and a device, but no action — there is nothing to validate. */
export interface ControlPreflightContext {
  device: DeviceConfigView;
  point: PointRow;
  /** The value the caller is CONSIDERING sending, so the vendor can answer about that specific
   *  command ("would a 30 minute run start?"). Optional; vendors pick their own default. */
  value?: number;
}

/**
 * Vendor adapter interface for all energy device vendors
 */
export interface VendorAdapter {
  // Basic vendor information
  readonly vendorType: string;
  readonly displayName: string;
  readonly dataSource: "poll" | "push" | "combined";

  // Credential requirements for this vendor
  readonly credentialFields?: CredentialField[];
  readonly supportsAddDevice?: boolean; // Whether this vendor supports the Add Device flow
  // How the Add Device dialog onboards this vendor. "credentials" (default) collects
  // credentialFields + Test Connection; "oauth-redirect" runs an in-dialog OAuth
  // redirect (Tesla Fleet API) with no credential fields.
  readonly addDeviceFlow?: "credentials" | "oauth-redirect";

  /**
   * How long one poll of this vendor may take before the cron loop abandons it and moves on.
   * Per-vendor because the honest ceilings differ by an order of magnitude: Tesla may legitimately
   * spend ~30 s waking a sleeping car, while Sigenergy's 502 retry ladder measured a flat 32 s of
   * pure waste. See `lib/cron/concurrency.ts`.
   */
  readonly pollDeadlineMs: number;

  // Check if device should be polled based on schedule
  shouldPoll(
    device: DeviceConfigView,
    forcePollAll: boolean,
    now: Date,
  ): Promise<{
    shouldPoll: boolean;
    reason?: string;
    nextPoll?: ZonedDateTime;
  }>;

  // Main polling function - handles all data collection
  poll(
    device: DeviceConfigView,
    credentials: any,
    options: PollOptions,
  ): Promise<PollingResult>;

  // Get the latest reading for this device
  getLastReading(systemId: number): Promise<LatestReadingData | null>;

  // Test connection with vendor
  testConnection(
    device: DeviceConfigView,
    credentials: any,
  ): Promise<TestConnectionResult>;

  // Optional command capability — present only on vendors that can actuate a writable point
  // (one whose `points.control` is non-NULL). Nine of the ten adapters omit it entirely and
  // are untouched by the command plane; that optionality is the whole design.
  readonly control?: ControlCapability;
}

/**
 * Stage timing information for Poll All modal
 * - login: Credential fetch (handled by cron route)
 * - fetch: API call to vendor (handled by base adapter)
 * - process: Insert readings + publish to QStash (handled by base adapter)
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
  sessionId?: string; // Database session ID (UUIDv7 text)
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
  deviceInfo?: {
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
