/**
 * Structured, localizable sentences from a device or a hub — an ICU MessageFormat subset.
 *
 * ## The problem
 *
 * The usher hub writes sentences that are read by a human in a browser ("a run is already latched
 * (stop at 2026-08-29T14:03:38.346Z); a request would EXTEND it"). The words are the hub's, and the
 * control dialog renders a refusal VERBATIM on purpose — it must never form a second opinion about
 * whether a start is safe. But an instant is not words. The hub has no locale and no timezone to
 * render one in, so it emitted ISO-8601, and the user read `...T14:03:38.346Z` in a dialog.
 *
 * ## The grammar
 *
 * A message travels as a TEMPLATE plus its VALUES, and only the renderer — which knows the viewer's
 * locale and zone — turns it into words:
 *
 *   {
 *     template: "a run is already latched (stop at {stopAt, time, short}); a request would EXTEND it",
 *     values:   { stopAt: "2026-08-29T14:03:38.346Z" }
 *   }
 *
 * That template is **ICU MessageFormat** — the Unicode/CLDR grammar behind `java.text.MessageFormat`,
 * FormatJS/react-intl, Android string resources and `Intl.MessageFormat`. It was chosen over
 * inventing a notation precisely because it is the one in common usage: the strings below are valid
 * input to `intl-messageformat` today, so swapping this renderer for the real library later is a
 * dependency change and not a rewrite of every hub sentence.
 *
 * We implement the subset the control plane actually needs, and refuse the rest visibly rather than
 * half-supporting it:
 *
 *   {name}                 - interpolate a string or number as-is
 *   {name, time, short}    - an instant (ISO-8601 or epoch ms) as a local time-of-day
 *   {name, date, short}    - an instant as a local date
 *   {name, number}         - a number in the viewer's locale
 *
 * `'{'` and `'}'` escape a literal brace, as in ICU. `{name, plural, ...}` and `{name, select, ...}`
 * are NOT supported: they need a real parser, and no control-plane sentence has wanted one. A
 * template using them leaves the slot in its raw form rather than throwing — see `renderMessage`.
 *
 * ## Why the fallback exists
 *
 * The hub deploys on Fly, independently of the web tier, and the generator's `lastError` reaches the
 * browser as a plain TEXT POINT value with no room for a template. So `localizeInstants` is kept as
 * belt-and-braces: it rewrites any bare ISO-8601 instant it finds in an already-rendered sentence,
 * leaving every other character untouched. Structured messages are the design; this is the net.
 */

import { formatTime12h } from "@/lib/fe-date-format";

/** A sentence that has not been rendered yet: ICU template + its arguments. */
export interface StructuredMessage {
  template: string;
  values?: Record<string, string | number | null | undefined>;
}

/** The wire may carry either shape — a legacy rendered string, or a template. */
export type MessageLike = string | StructuredMessage | null | undefined;

/** Matches an ISO-8601 instant: date, `T`, time, optional fraction, and a REQUIRED zone. */
const ISO_INSTANT =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})/g;

/**
 * One token: EITHER an ICU quoted brace (`'{'`, `'}'`) OR an argument — `{name}` / `{name, type}` /
 * `{name, type, style}`. Nothing nested.
 *
 * The two alternatives share one pattern on purpose. A quoted literal has to be recognised BEFORE
 * the brace it contains can be read as the start of an argument, and `String.replace` scans forward
 * without re-reading what it emits — so a single pass over this handles escaping correctly with no
 * sentinel, no placeholder substitution, and no second traversal.
 */
const TOKEN = /'(\{|\})'|\{\s*(\w+)\s*(?:,\s*(\w+)\s*(?:,\s*(\w+)\s*)?)?\}/g;

/**
 * An instant as local time-of-day in the house spelling ("4:16pm").
 *
 * Deliberately the browser's OWN zone, not the device's: this renders a sentence about what is
 * happening to hardware *now*, read by a person looking at a clock on the same screen.
 */
function timeWords(d: Date): string {
  return formatTime12h({ hour: d.getHours(), minute: d.getMinutes() });
}

function dateWords(d: Date): string {
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Parse an ICU argument value that is meant to be an instant. Null when it is not one. */
function asDate(v: unknown): Date | null {
  if (typeof v === "number") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/**
 * Rewrite every bare ISO-8601 instant in an already-rendered sentence as a local time.
 *
 * Only the instant changes; every other character — including the hub's own punctuation and word
 * order — survives byte-for-byte, which is what lets a verbatim refusal stay verbatim.
 */
export function localizeInstants(text: string): string {
  return text.replace(ISO_INSTANT, (iso) => {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return iso;
    return timeWords(new Date(ms));
  });
}

/**
 * Render an ICU-subset template against its values, in the viewer's locale and zone.
 *
 * An argument the values do not supply is left in its raw `{name}` form rather than becoming the
 * string "undefined": a visibly unfilled slot is a bug report, where "undefined" is a lie. Same for
 * an unsupported argument type — better a template that reads oddly than a sentence that silently
 * says the wrong thing about a diesel engine.
 */
export function renderMessage(msg: StructuredMessage): string {
  const values = msg.values ?? {};

  return msg.template.replace(
    TOKEN,
    (raw, quoted?: string, name?: string, type?: string, style?: string) => {
      // `'{'` / `'}'` — an escaped brace. Emit the brace itself; nothing re-reads it.
      if (quoted) return quoted;
      if (!name || !(name in values)) return raw;
      const v = values[name];
      if (v == null) return raw;

      if (type === undefined) return String(v);
      if (type === "number") {
        return typeof v === "number" ? v.toLocaleString() : String(v);
      }
      if (type === "time") {
        const d = asDate(v);
        // `short` is the only style we spell; anything else falls through to the same words rather
        // than pretending to honour a width we do not implement.
        void style;
        return d ? timeWords(d) : String(v);
      }
      if (type === "date") {
        const d = asDate(v);
        return d ? dateWords(d) : String(v);
      }
      // `plural`, `select`, or a typo: leave the slot visible.
      return raw;
    },
  );
}

/**
 * Render whatever the wire carried into one display string.
 *
 * A `StructuredMessage` is rendered; a legacy plain string is passed through `localizeInstants`, so
 * an old hub build that still bakes an ISO into its sentence is fixed on the client too.
 */
export function renderMessageLike(msg: MessageLike): string | null {
  if (msg == null) return null;
  if (typeof msg === "string") return msg ? localizeInstants(msg) : null;
  if (typeof msg.template !== "string") return null;
  return renderMessage(msg);
}
