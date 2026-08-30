/**
 * A sentence the hub writes but does not render — an ICU MessageFormat template plus its arguments.
 *
 * The hub has no locale and no timezone. When it bakes an instant into a sentence the only thing it
 * can write is ISO-8601, and a browser then shows a human "until 2026-08-29T14:03:38.346Z". So a
 * sentence carrying an instant travels UNRENDERED and the reader's client spells it:
 *
 *   { template: "Running until {stopAt, time, short} — starting again extends …",
 *     values:   { stopAt: "2026-08-29T14:03:38.346Z" } }
 *
 * `template` is ICU MessageFormat — the grammar behind java.text.MessageFormat, FormatJS/react-intl
 * and Intl.MessageFormat — so these strings are valid input to a real ICU library, not a private
 * notation. The web tier renders the subset it needs in `lib/control/message-format.ts`.
 *
 * 🛑 EVERY sentence that carries one of these is ALSO emitted in its rendered `*.reason`/`verdict`
 * form. The hub deploys on Fly independently of the web tier, so a web build older than this one
 * must keep working — it reads the flat string and never sees the template. Do not drop the flat
 * field; it is the compatibility leg, not a duplicate.
 */
export interface StructuredMessage {
  template: string;
  values?: Record<string, string | number | null | undefined>;
}
