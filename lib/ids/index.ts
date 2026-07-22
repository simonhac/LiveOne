/**
 * Config v4 public IDs — TypeIDs (`<prefix>_<base32 uuidv7>`) with compile-time-distinct brands.
 *
 * Client-safe barrel: no `node:crypto`. Above the data-access seam everything speaks these TypeIDs;
 * the DB stores the raw uuid and the internal integer `rid` lives only below the seam (see
 * docs/plans/config-v4-clean-sheet.md §5). Usage:
 *
 *   const id = Device.generate();           // DeviceId, e.g. "dv_01j9xz…"
 *   const uuid = Point.toUuid(pointId);     // -> canonical uuid for the DB
 *   const r = Area.parse(untrusted);        // {ok:true,id} | {ok:false,code,message}
 *   Point.toUuid(Device.generate());        // compile error — brands are distinct
 */
export {
  type TypeId,
  type DeviceId,
  type PointId,
  type AreaId,
  type DashboardId,
  type DerivationId,
  type BindingId,
  type ParseError,
  type ParseOk,
  type ParseResult,
  type ParseErrorCode,
  ID_PREFIX,
} from "./types";

export {
  encodeTypeId,
  decodeTypeId,
  makeEntityCodec,
  type EntityCodec,
} from "./typeid";

export { newUuidV7, isCanonicalUuid } from "./uuid";
export {
  encodeBase32,
  decodeBase32,
  Base32Error,
  BASE32_ALPHABET,
} from "./base32";

import type { EntityCodec } from "./typeid";
import { makeEntityCodec } from "./typeid";

export const Device: EntityCodec<"dv"> = makeEntityCodec("dv");
export const Point: EntityCodec<"pt"> = makeEntityCodec("pt");
export const Area: EntityCodec<"ar"> = makeEntityCodec("ar");
export const Dashboard: EntityCodec<"db"> = makeEntityCodec("db");
export const Derivation: EntityCodec<"dx"> = makeEntityCodec("dx");
export const Binding: EntityCodec<"bn"> = makeEntityCodec("bn");
