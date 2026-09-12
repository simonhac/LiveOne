/**
 * Config v4 public IDs — TypeIDs (`<prefix>_<base32 uuidv7>`) with compile-time-distinct brands.
 *
 * Client-safe barrel: no `node:crypto`. Above the data-access seam everything speaks these TypeIDs;
 * the DB stores the raw uuid and the internal integer `rid` lives only below the seam (see
 * the config-v4 clean-sheet design §5). Usage:
 *
 *   const id = Device.generate();           // DeviceId, e.g. "dv_01j9xz…"
 *   const uuid = Point.toUuid(pointId);     // -> canonical uuid for the DB
 *   const r = Area.parse(untrusted);        // {ok:true,id} | {ok:false,code,message}
 *   Point.toUuid(Device.generate());        // compile error — brands are distinct
 */
export {
  type DeviceId,
  type PointId,
  type AreaId,
  type AutomationId,
  ID_PREFIX,
} from "./types";

export { encodeTypeId, decodeTypeId, type EntityCodec } from "./typeid";

export { newUuidV7, isCanonicalUuid } from "./uuid";
import type { EntityCodec } from "./typeid";
import { makeEntityCodec } from "./typeid";

export const Device: EntityCodec<"dv"> = makeEntityCodec("dv");
export const Point: EntityCodec<"pt"> = makeEntityCodec("pt");
export const Area: EntityCodec<"ar"> = makeEntityCodec("ar");
export const Dashboard: EntityCodec<"db"> = makeEntityCodec("db");
export const Derivation: EntityCodec<"dx"> = makeEntityCodec("dx");
export const Binding: EntityCodec<"bn"> = makeEntityCodec("bn");
export const Automation: EntityCodec<"au"> = makeEntityCodec("au");
