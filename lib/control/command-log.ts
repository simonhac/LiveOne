/**
 * One `point_commands` wire row → one human sentence — the activity log's voice.
 *
 * The `progress.ts` discipline: DB-free, React-free, fetch-free, `nowMs` injected, every case
 * table-tested. The reason vocabulary is shared with the inline notice via `describeDecline`,
 * so "you pressed Stop but it was already stopped" reads the same in both places.
 *
 * Sentences are complete and calm — "You started charging", "'Stop after 15 min' stopped
 * charging", "You asked to start charging, but the car was already charging". Time RENDERING
 * (locale, "yesterday") is the UI's job; this module only hands back `timeMs`.
 */
import { describeDecline } from "./decline-copy";
import type { PointActionName } from "./point-control";

/** A `GET /api/v4/points/{pt}/commands` entry, as it arrives in the browser (ISO strings). */
export interface CommandLogEntryJson {
  pointId: string;
  logicalPath: string | null;
  metricType: string;
  action: string;
  value: number | null;
  status: string; // pending | ok | rejected | failed
  reason: string | null;
  error: string | null;
  requestedBy:
    | { kind: "user" }
    | { kind: "automation"; automationId: string; name: string | null };
  requestedAt: string;
  completedAt: string | null;
}

export interface CommandLogLine {
  /** `requestedAt` as epoch-ms — the UI renders it. */
  timeMs: number;
  sentence: string;
  /** Text-colour hint only: benign is normal-weight reassurance, never red. */
  tone: "ok" | "benign" | "error" | "pending";
}

/** How long a `pending` row can sit before the log says so out loud. */
const PENDING_STALE_MS = 2 * 60_000;

/**
 * The intent, as a verb phrase: what was ASKED, independent of how it went.
 * Unknown addresses degrade to an honest generic rather than guessing.
 */
function verbPhrase(e: CommandLogEntryJson): string {
  const address = `${e.logicalPath ?? ""}/${e.metricType}`;
  switch (address) {
    case "ev.charge/active":
      if (e.action === "turn_on") return "start charging";
      if (e.action === "turn_off") return "stop charging";
      break;
    case "ev.charge.limit/soc":
      if (e.action === "set_value" && e.value != null)
        return `set the charge limit to ${Math.round(e.value)}%`;
      break;
    case "ev.charge.limit/current":
      if (e.action === "set_value" && e.value != null)
        return `set charging to ${Math.round(e.value)} A`;
      break;
  }
  return `send '${e.action}' to ${address}`;
}

/** The verb phrase in the simple past, for the clean-success sentence. */
function pastPhrase(e: CommandLogEntryJson): string {
  const phrase = verbPhrase(e);
  if (phrase.startsWith("start ")) return `started ${phrase.slice(6)}`;
  if (phrase.startsWith("stop ")) return `stopped ${phrase.slice(5)}`;
  if (phrase.startsWith("set ")) return phrase; // "set" is its own past tense
  if (phrase.startsWith("send ")) return `sent ${phrase.slice(5)}`;
  return phrase;
}

function subject(e: CommandLogEntryJson): string {
  if (e.requestedBy.kind === "user") return "You";
  return e.requestedBy.name ? `‘${e.requestedBy.name}’` : "An automation";
}

/** Lower-case a benign-decline sentence so it reads as a clause after "but". */
function asClause(text: string): string {
  const t = text.replace(/\.$/, "");
  return t.charAt(0).toLowerCase() + t.slice(1);
}

export function formatCommandEntry(
  e: CommandLogEntryJson,
  nowMs: number,
): CommandLogLine {
  const timeMs = Date.parse(e.requestedAt);
  const who = subject(e);

  switch (e.status) {
    case "ok":
      return { timeMs, sentence: `${who} ${pastPhrase(e)}`, tone: "ok" };

    case "rejected": {
      // A benign decline ("not_charging" back from a Stop) is reassurance; a protocol refusal
      // is a real failure. `describeDecline` is the shared judge of which is which.
      const decline = describeDecline(e.action as PointActionName, e.reason);
      if (e.reason && decline.known) {
        return {
          timeMs,
          sentence: `${who} asked to ${verbPhrase(e)}, but ${asClause(decline.text)}`,
          tone: "benign",
        };
      }
      const detail = e.error ?? e.reason;
      return {
        timeMs,
        sentence: `${who} asked to ${verbPhrase(e)}, but the car refused${detail ? ` (${detail})` : ""}`,
        tone: "error",
      };
    }

    case "failed":
      return {
        timeMs,
        sentence: `${who} asked to ${verbPhrase(e)}, but the car couldn’t be reached`,
        tone: "error",
      };

    case "pending":
      return {
        timeMs,
        sentence:
          nowMs - timeMs > PENDING_STALE_MS
            ? `${who} asked to ${verbPhrase(e)} (still waiting)`
            : `${who} asked to ${verbPhrase(e)}…`,
        tone: "pending",
      };
  }

  // An unknown status (schema grew, client didn't): state the ask, claim nothing about the outcome.
  return { timeMs, sentence: `${who} asked to ${verbPhrase(e)}`, tone: "ok" };
}
