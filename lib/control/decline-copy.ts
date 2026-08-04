/**
 * Human copy for a BENIGN vendor decline — the `200 {ok:false, reason}` leg of the command
 * plane. "The car was already charging" is reassurance, not an error, and must never wear the
 * destructive-red styling a real failure does.
 *
 * Lives in `lib/` (not beside the dialog) for the `point-ref.ts` reasons: jest's roots don't
 * include `components/`, and the activity-log formatter (`command-log.ts`) shares this map so
 * the inline notice and the log line always agree on what a reason means.
 *
 * The reason vocabulary is Tesla's, pass-through and undocumented — only `not_charging` has
 * ever been observed in our own code paths, so the unknown-reason fallback is the case that
 * matters most: calm, generic, and it still shows the raw token for the curious.
 */
import type { PointActionName } from "./point-control";

export interface DeclineCopy {
  /** The sentence to show. Always complete and calm. */
  text: string;
  /** False when we fell through to the generic wording. */
  known: boolean;
}

/**
 * What a benign decline means, in words. `action` gives the context that makes a terse reason
 * read naturally ("is_charging" after a start attempt means "already done").
 */
export function describeDecline(
  action: PointActionName,
  reason: string | null,
): DeclineCopy {
  const r = (reason ?? "").toLowerCase();

  switch (r) {
    case "is_charging":
    case "charging":
      return action === "turn_off"
        ? { text: "The car is still charging.", known: true }
        : { text: "The car says it’s already charging.", known: true };
    case "not_charging":
      return { text: "Charging was already stopped.", known: true };
    case "complete":
      return { text: "The charge is already complete.", known: true };
    case "already_set":
      return { text: "That was already set.", known: true };
    case "disconnected":
      return { text: "The car isn’t plugged in.", known: true };
  }

  return {
    text: reason
      ? `The car didn’t need to do that (reason: ${reason}).`
      : "The car didn’t need to do that.",
    known: false,
  };
}
