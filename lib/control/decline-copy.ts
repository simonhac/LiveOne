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
 *
 * 🛑 NOT EVERY VENDOR SPEAKS IN TOKENS. The DeepSea generator's declines arrive from the usher hub
 * as COMPLETE HUMAN CLAUSES, written to be read ("the module is not in Auto (mode=Stop) — a
 * possible local lockout at the panel, and not overridable remotely"). Rewriting one of those into
 * house copy could only lose information, so the generator address passes them through verbatim.
 * That is why this function takes the point ADDRESS: the right treatment for a reason depends on
 * who wrote it. (`gateStart()` on the hub writes them lower-case and unpunctuated on purpose, so
 * the same clause reads correctly here after "but" and standing alone in the probe's verdict.)
 */
import type { PointActionName } from "./point-control";
import { GENERATOR_RUN_REQUEST_ADDRESS } from "./addresses";

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
  /** `logicalPath/metricType` of the commanded point. Omitted ⇒ the Tesla vocabulary. */
  address?: string | null,
): DeclineCopy {
  if (address === GENERATOR_RUN_REQUEST_ADDRESS) {
    // The hub already said it better than we could. `known: true` so the caller styles it as
    // reassurance rather than falling through to the generic "didn't need to do that".
    return reason
      ? { text: reason, known: true }
      : {
          text: "The generator hub declined the request.",
          known: false,
        };
  }

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
