/**
 * Session payload builder.
 *
 * Builds the queue `Session` payload from a completed session record. The
 * payload rides the combined poll message emitted by `publishPoll`
 * (see `poll-collector.ts`); there is no standalone session publish.
 */

import { Session } from "./types";
import { formatTime_fromJSDate } from "@/lib/date-utils";

/**
 * Input data for publishing a session
 */
export interface SessionPublishInput {
  id: string;
  sessionLabel: string | null;
  systemId: number;
  cause: string;
  started: Date;
  duration: number;
  successful: boolean | null;
  errorCode: string | null;
  error: string | null;
  response: unknown;
  numRows: number;
  createdAt: Date;
}

/**
 * Format a Date as ISO 8601 with system's timezone offset
 */
function formatTimestamp(date: Date, timezoneOffsetMin: number): string {
  return formatTime_fromJSDate(date, timezoneOffsetMin);
}

/**
 * Build a Session payload from session input data.
 *
 * Pure function (no I/O): converts SessionPublishInput into the queue Session
 * object, formatting timestamps using the supplied timezone offset.
 *
 * @param input - Session data to convert
 * @param timezoneOffsetMin - System timezone offset in minutes
 */
export function buildSessionPayload(
  input: SessionPublishInput,
  timezoneOffsetMin: number,
): Session {
  return {
    sessionId: input.id,
    sessionLabel: input.sessionLabel,
    cause: input.cause,
    started: formatTimestamp(input.started, timezoneOffsetMin),
    durationMs: input.duration,
    successful: input.successful,
    errorCode: input.errorCode,
    error: input.error,
    response: input.response,
    numRows: input.numRows,
    startTime: formatTimestamp(input.createdAt, timezoneOffsetMin),
  };
}
