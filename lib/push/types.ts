/**
 * gusher — the generic push (receiver) contract, shared by the receiver (`app/api/gush/route.ts`)
 * and the collector's pushers (the usher's musher/fusher sources).
 *
 * The wire types now live in the shared `@liveone/protocol` package (the app ⇄ usher boundary); this
 * module re-exports them so existing `@/lib/push/types` importers keep working.
 */

export type { PushReading, GushRequestBody } from "@liveone/protocol";
