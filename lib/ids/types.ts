/**
 * Branded public-ID types for config v4.
 *
 * A `TypeId<P>` is the wire/URL form of a config row's identity: `"<prefix>_<26-char base32 uuidv7>"`
 * (e.g. `dv_01j9xz…`). The DB stores the raw uuid; the prefix is presentation only. The brand makes
 * the seven entity IDs NOMINALLY distinct at compile time — passing a `DeviceId` where a `PointId` is
 * expected is a type error, which is the whole point of the scheme (it turns the old integer-handle
 * confusion into a parse/compile error). See the config-v4 clean-sheet design §5.
 */

declare const __idBrand: unique symbol;

/** A public config-row id tagged with its 2-letter prefix `P`. Runtime value is a plain string. */
export type TypeId<P extends string> = string & { readonly [__idBrand]: P };

/**
 * One branded id per entity in {@link ID_PREFIX}, in the same order. The three with no named
 * importer today are the codecs' return types all the same — `Dashboard.parse()` hands back a
 * `DashboardId` whether or not the caller writes the name — so the set is complete by construction
 * and a partial one would be a trap for the next person to annotate a signature.
 */
export type DeviceId = TypeId<"dv">;
export type PointId = TypeId<"pt">;
export type AreaId = TypeId<"ar">;
/** @knipignore Complete-by-construction id family — see {@link DeviceId}. */
export type DashboardId = TypeId<"db">;
/** @knipignore Complete-by-construction id family — see {@link DeviceId}. */
export type DerivationId = TypeId<"dx">;
/** @knipignore Complete-by-construction id family — see {@link DeviceId}. */
export type BindingId = TypeId<"bn">;
export type AutomationId = TypeId<"au">;

/** Canonical entity -> 2-letter prefix map (the single source of truth for the prefixes). */
export const ID_PREFIX = {
  device: "dv",
  point: "pt",
  area: "ar",
  dashboard: "db",
  derivation: "dx",
  binding: "bn",
  automation: "au",
} as const satisfies Record<string, string>;

type ParseErrorCode =
  | "wrong-prefix"
  | "empty-prefix"
  | "malformed-format"
  | "malformed-suffix";

export interface ParseError {
  ok: false;
  code: ParseErrorCode;
  message: string;
}

interface ParseOk<T> {
  ok: true;
  id: T;
}

export type ParseResult<T> = ParseOk<T> | ParseError;
