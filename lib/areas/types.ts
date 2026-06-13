/**
 * Typed shapes for the P3 Areas semantic layer.
 *
 * `AreaLocation` is the per-Area physical-location object stored in `areas.location` (jsonb). It is
 * the multi-site equivalent of Home Assistant's single global home-location object
 * (latitude/longitude/elevation/time_zone/unit_system): LiveOne hosts many Areas, each potentially a
 * different site, so the location lives per-Area rather than once per install. The Area row already
 * carries the time_zone slice (`timezoneOffsetMin`/`displayTimezone`); this completes the object.
 *
 * It is used to DERIVE downstream facts (e.g. the NEM grid region via
 * `lib/vendors/openelectricity/region.ts`) — it never stores a derived value like the region itself.
 */
export interface AreaLocation {
  /** ISO-3166-1 alpha-2 country code, e.g. "AU". */
  country: string;
  /** State/territory code, e.g. "NSW" | "VIC" | "QLD" | "SA" | "TAS" | "WA" | "NT" | "ACT". */
  state?: string;
  /** Postcode — fallback for region inference when `state` is absent. */
  postcode?: string;
  /** Optional geocoordinates (not required for NEM-region inference). */
  lat?: number;
  lng?: number;
}
