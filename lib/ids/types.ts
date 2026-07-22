/**
 * Branded public-ID types for config v4.
 *
 * A `TypeId<P>` is the wire/URL form of a config row's identity: `"<prefix>_<26-char base32 uuidv7>"`
 * (e.g. `dv_01j9xz…`). The DB stores the raw uuid; the prefix is presentation only. The brand makes
 * the six entity IDs NOMINALLY distinct at compile time — passing a `DeviceId` where a `PointId` is
 * expected is a type error, which is the whole point of the scheme (it turns the old integer-handle
 * confusion into a parse/compile error). See docs/plans/config-v4-clean-sheet.md §5.
 */

declare const __idBrand: unique symbol;

/** A public config-row id tagged with its 2-letter prefix `P`. Runtime value is a plain string. */
export type TypeId<P extends string> = string & { readonly [__idBrand]: P };

export type DeviceId = TypeId<"dv">;
export type PointId = TypeId<"pt">;
export type AreaId = TypeId<"ar">;
export type DashboardId = TypeId<"db">;
export type DerivationId = TypeId<"dx">;
export type BindingId = TypeId<"bn">;

/** Canonical entity -> 2-letter prefix map (the single source of truth for the prefixes). */
export const ID_PREFIX = {
  device: "dv",
  point: "pt",
  area: "ar",
  dashboard: "db",
  derivation: "dx",
  binding: "bn",
} as const satisfies Record<string, string>;

export type ParseErrorCode =
  | "wrong-prefix"
  | "empty-prefix"
  | "malformed-format"
  | "malformed-suffix";

export interface ParseError {
  ok: false;
  code: ParseErrorCode;
  message: string;
}

export interface ParseOk<T> {
  ok: true;
  id: T;
}

export type ParseResult<T> = ParseOk<T> | ParseError;
