/**
 * TypeID encode/decode + the per-entity codec factory.
 *
 * A TypeID is `"<prefix>_<26-char base32 uuidv7>"`. `encodeTypeId` is for trusted uuids (from the DB
 * / a fresh mint) and throws on a bad uuid — a programmer error. `decodeTypeId` is for UNTRUSTED wire
 * input and returns a typed `ParseError` (never throws) so route handlers can map it to a 4xx.
 */
import { type ParseError, type ParseResult, type TypeId } from "./types";
import { decodeBase32, encodeBase32 } from "./base32";
import { bytesToUuid, newUuidV7, uuidToBytes } from "./uuid";

const SUFFIX_LEN = 26;

/** Trusted uuid -> branded TypeID. Throws (via {@link uuidToBytes}) if `uuid` is not canonical. */
export function encodeTypeId<P extends string>(
  prefix: P,
  uuid: string,
): TypeId<P> {
  const suffix = encodeBase32(uuidToBytes(uuid));
  return (prefix.length ? `${prefix}_${suffix}` : suffix) as TypeId<P>;
}

/** Untrusted string -> `{ok, uuid}` if it is a well-formed `<expectedPrefix>_…`, else a `ParseError`. */
export function decodeTypeId<P extends string>(
  expectedPrefix: P,
  s: string,
): { ok: true; uuid: string } | ParseError {
  if (typeof s !== "string" || s.length === 0)
    return {
      ok: false,
      code: "malformed-format",
      message: "empty or non-string id",
    };

  let prefix: string;
  let suffix: string;
  if (s.length === SUFFIX_LEN) {
    prefix = "";
    suffix = s;
  } else {
    // The suffix is always the last 26 chars (base32 has no `_`); a `_` must sit immediately before it.
    const sep = s.length - SUFFIX_LEN - 1;
    if (sep < 0 || s[sep] !== "_")
      return {
        ok: false,
        code: "malformed-format",
        message: `expected "<prefix>_<26-char suffix>", got ${JSON.stringify(s)}`,
      };
    prefix = s.slice(0, sep);
    suffix = s.slice(sep + 1);
    if (prefix.length === 0)
      return {
        ok: false,
        code: "empty-prefix",
        message: "prefix must be non-empty when an underscore is present",
      };
  }

  if (prefix !== expectedPrefix)
    return {
      ok: false,
      code: "wrong-prefix",
      message: `expected prefix ${JSON.stringify(expectedPrefix)}, got ${JSON.stringify(prefix)}`,
    };

  try {
    return { ok: true, uuid: bytesToUuid(decodeBase32(suffix)) };
  } catch (e) {
    return {
      ok: false,
      code: "malformed-suffix",
      message: e instanceof Error ? e.message : "invalid base32 suffix",
    };
  }
}

/** The per-entity codec surface — one instance per prefix, exported from `./index`. */
export interface EntityCodec<P extends string> {
  readonly prefix: P;
  /** Trusted uuid -> branded TypeID. */
  encode(uuid: string): TypeId<P>;
  /** Branded TypeID -> canonical lowercase uuid. Throws if `id` is not this entity's TypeID. */
  toUuid(id: TypeId<P>): string;
  /** Untrusted string -> branded TypeID or a typed error. Never throws. */
  parse(s: string): ParseResult<TypeId<P>>;
  /** Type guard: is `s` a well-formed TypeID for this entity? */
  is(s: string): s is TypeId<P>;
  /** Mint a fresh TypeID (uuidv7 under the hood). */
  generate(): TypeId<P>;
}

export function makeEntityCodec<P extends string>(prefix: P): EntityCodec<P> {
  return {
    prefix,
    encode: (uuid) => encodeTypeId(prefix, uuid),
    toUuid: (id) => {
      const r = decodeTypeId(prefix, id as unknown as string);
      if (!r.ok) throw new TypeError(`not a ${prefix}_ id: ${r.message}`);
      return r.uuid;
    },
    parse: (s) => {
      const r = decodeTypeId(prefix, s);
      return r.ok ? { ok: true, id: s as TypeId<P> } : r;
    },
    is: (s): s is TypeId<P> => decodeTypeId(prefix, s).ok,
    generate: () => encodeTypeId(prefix, newUuidV7()),
  };
}
