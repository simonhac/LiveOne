/**
 * The `derivation` domain's shared vocabulary and resolution.
 *
 * The arg shapes, the enums that MIRROR server-side registries (kept as literals here for the same
 * reason `runsConfigSchema` keeps one — deriving them would drag the role registry into the CLI
 * bundle), the wire types, and the resolution every verb starts with.
 *
 * 🛑 **Nothing here is scoped by an area any more.** A derivation's site is DERIVED from its source
 * points, so `/api/v4/derivations` returns everything the caller can read and a `dx_` is globally
 * resolvable — which is what retired "there is no fleet-wide listing; 'which detectors exist
 * anywhere' means one call per area". `--device`/`--area` narrow that listing when a bare role names
 * more than one row; they are not, and must not become, the address.
 */
import { CliFailure, EXIT, num, type Ctx } from "@/lib/cli/cli";
import { type ApiSession } from "@/lib/cli-kit/api-session";
import { Device, Point } from "@/lib/ids";
import {
  matchRef,
  pointOnDevice,
  resolveArea,
  resolveRef,
  str,
  usage,
  type DeviceRef,
} from "../shared";

export const DEVICE_ARG = {
  name: "device",
  required: true,
  help: "The device the derivation is about: its dv_… id, integer handle, slug, or name",
} as const;

export const SCOPE_ARG = {
  name: "scope",
  required: false,
  help: "Optional: only derivations touching this DEVICE (or, failing that, this area). Bare = everything you can read",
} as const;

export const DERIVATION_ARG = {
  name: "derivation",
  required: true,
  help: "A derivation: its dx_… id, its name, or its role (narrow with --device= if a role names more than one)",
} as const;

/**
 * The narrowing flags. They are not the address — a `dx_` is — but a ROLE is the ref an operator
 * actually reaches for, and a role is only unique per owner device now that the listing is
 * fleet-wide. So the disambiguation the old `<area>` positional FORCED on every invocation is
 * available exactly when it is needed and absent when it is not.
 */
export const NARROW_FLAGS = {
  device: {
    type: "string",
    placeholder: "ref",
    help: "Only derivations touching this device (dv_… id, handle, slug or name)",
  },
  area: {
    type: "string",
    placeholder: "ref",
    help: "Only derivations touching one of this area's member devices",
  },
} as const;

/** The two `derivations.kind` values this build knows. Mirrors lib/derivations/kinds.ts. */
export const KINDS = ["run-detector", "hws-model"] as const;

/**
 * The roles a run detector can be configured for. Mirrors `TRACKABLE_ROLE_IDS`
 * (lib/roles/registry.ts, derived from `device.trackable`) — kept as a literal here for the same
 * reason `runsConfigSchema` keeps one: deriving the enum would drag the role registry into the
 * spec, which the CLI harness parses before it does anything else. Keep the two in step by hand;
 * the server validates the value regardless, so a stale list here refuses rather than misfires.
 */
export const TRACKABLE_ROLES = ["generator", "ev"] as const;

/**
 * The threshold knobs, as `[CLI flag, params key]`. One table so `create` and `set` cannot disagree
 * about which flag writes which key — the sort of drift that is invisible until a detector is
 * configured through the verb that got it wrong.
 */
export const KNOBS = [
  ["upper", "upperW"],
  ["lower", "lowerW"],
  ["hysteresis", "hysteresisW"],
  ["delayOn", "delayOnSeconds"],
  ["delayOff", "delayOffSeconds"],
] as const;

/** The knob flags, shared by `create` and `set`. */
export const KNOB_FLAGS = {
  upper: {
    type: "number",
    placeholder: "W",
    help: "Above this, the device is ON",
  },
  lower: {
    type: "number",
    placeholder: "W",
    help: "Below this, the device is OFF",
  },
  hysteresis: {
    type: "number",
    placeholder: "W",
    help: "Deadband around the threshold",
  },
  delayOn: {
    type: "number",
    placeholder: "seconds",
    help: "Ignore an on-signal shorter than this",
  },
  delayOff: {
    type: "number",
    placeholder: "seconds",
    help: "Bridge a gap shorter than this. 🛑 Must comfortably EXCEED the point's sample interval, or every poll gap closes a run",
  },
} as const;

/** Read the knob flags that were actually passed, as `params` keys. Absent flags stay absent. */
export function knobsFrom(ctx: Ctx): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [flag, key] of KNOBS) {
    const v = num(ctx, flag);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

export interface WireDevice extends DeviceRef {
  id: string | null;
  legacySystemId: number;
  name: string;
  slug: string | null;
}

export interface WireDerivation {
  id: string;
  kind: string;
  role: string | null;
  name: string;
  enabled: boolean;
  output: string;
  outputPointId: string | null;
  params: Record<string, unknown>;
  sourcePoints: Record<string, string | null>;
  /**
   * The device set the request was AUTHORIZED against (PR 3). Not decoration: it is what a `runs`
   * card hangs off, what a 403 would have named, and — since the site is no longer configured — the
   * only answer this wire carries to "where does this detector live".
   */
  devices: string[];
}

export interface WirePoint {
  id: string;
  logicalPath: string | null;
  metricType: string;
  unit: string | null;
  name: string;
  active: boolean;
}

export interface WireInterval {
  startTime: string;
  endTime: string | null;
  durationSeconds: number | null;
  energyKwh: number | null;
  avgSignal: number | null;
  maxSignal: number | null;
  signalUnit: string | null;
  costC: number | null;
  sampleCount: number;
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export async function listDevices(s: ApiSession): Promise<WireDevice[]> {
  const { devices } = await s.get<{ devices: WireDevice[] }>("/api/v4/devices");
  return devices;
}

/** Resolve a device ref against a list already in hand. */
export function resolveDeviceIn(
  devices: WireDevice[],
  ref: string,
): WireDevice {
  return resolveRef(devices, ref, {
    noun: "device",
    listCmd: "liveone device list",
  });
}

/**
 * A device ref → the device, treating a well-formed `dv_` as an ADDRESS.
 *
 * 🛑 `/api/v4/devices` is NARROWER than the set a derivation can touch: it serves the ACTIVE
 * owned∪granted∪public devices and does not widen for admins, while `lib/derivations/scope.ts`
 * authorizes against every device in the wiring. So resolving every ref through the listing would
 * refuse ids that the derivations collection itself accepts — the CLI declaring "no such device"
 * about one it can plainly see in a derivation's own `devices` array.
 *
 * A NAME still has to be resolved (that is what the listing is for) and still refuses when it
 * misses. Only the id short-circuits, and only to a name-less stand-in: nothing downstream of here
 * uses more than `id` and `name`, and rendering the id as the name is at least honest about what is
 * known.
 */
export function deviceFromRef(devices: WireDevice[], ref: string): DeviceRef {
  if (Device.is(ref))
    return devices.find((d) => d.id === ref) ?? { id: ref, name: ref };
  return resolveDeviceIn(devices, ref);
}

/**
 * `dv_…` → the device, for rendering. Every listing needs it: the wire carries a derivation's
 * device set as ids, and an id is not an answer to "where does this run detector live".
 */
export function devicesById(devices: WireDevice[]): Map<string, WireDevice> {
  return new Map(devices.flatMap((d) => (d.id ? [[d.id, d] as const] : [])));
}

/** The device set of one derivation, as names — `(unknown device)` for anything withheld. */
export function deviceNames(
  row: WireDerivation,
  byId: Map<string, WireDevice>,
): string {
  return row.devices.length === 0
    ? "(no device — broken wiring)"
    : row.devices.map((id) => byId.get(id)?.name ?? id).join(", ");
}

// ---------------------------------------------------------------------------
// The collection
// ---------------------------------------------------------------------------

/** The query string `/api/v4/derivations` narrows on. Every field is optional; all AND together. */
export interface DerivationFilter {
  /** A `dv_…` id — the derivation must touch this device. */
  device?: string;
  /** An `ar_…` id — the derivation must touch one of its members. */
  area?: string;
  kind?: string;
  role?: string;
  enabled?: boolean;
}

export async function listDerivations(
  s: ApiSession,
  filter: DerivationFilter = {},
): Promise<WireDerivation[]> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filter))
    if (v !== undefined) qs.set(k, String(v));
  const { derivations } = await s.get<{ derivations: WireDerivation[] }>(
    `/api/v4/derivations${qs.size ? `?${qs}` : ""}`,
  );
  return derivations;
}

/**
 * Read `--device`/`--area` into a filter, resolving each ref to its id.
 *
 * Both may be given: the server INTERSECTS them, which is the only reading of "and" that cannot
 * accidentally widen a listing.
 */
export async function narrowFrom(
  ctx: Ctx,
  s: ApiSession,
  devices: WireDevice[],
): Promise<{ filter: DerivationFilter; label: string }> {
  const filter: DerivationFilter = {};
  const parts: string[] = [];
  const deviceRef = str(ctx, "device");
  if (deviceRef !== undefined) {
    const d = deviceFromRef(devices, deviceRef);
    filter.device = d.id!;
    parts.push(d.name);
  }
  const areaRef = str(ctx, "area");
  if (areaRef !== undefined) {
    const a = await resolveArea(s, areaRef);
    filter.area = a.id!;
    parts.push(a.displayName);
  }
  return { filter, label: parts.join(" ∩ ") || "everything you can read" };
}

/**
 * Resolve a positional SCOPE — a device, else an area.
 *
 * 🛑 Device FIRST, and it is not arbitrary: every device has an eagerly-minted area of one carrying
 * the same display name, so "resolve against both and complain when both match" would make the
 * common case an error. Device-first is also the vocabulary this domain now addresses in.
 *
 * ⚠️ It is NOT merely a narrowing, and the caller is told which way it went. A name or slug that
 * happens to be shared by a device and an UNRELATED area (nothing stops an area being named after a
 * device it does not contain) resolves to the device, and the two sets may be disjoint rather than
 * nested. So the label this returns is printed, and the handler notes the `--area=` spelling on
 * stderr whenever the winning match came from a name rather than an id.
 */
export async function resolveScope(
  s: ApiSession,
  ref: string,
  devices: WireDevice[],
): Promise<{ filter: DerivationFilter; label: string }> {
  // An id first, and without consulting the listing — see `deviceFromRef`. A `dv_` can name a device
  // the listing omits, and it can never name an area, so there is nothing to fall through to.
  if (Device.is(ref)) {
    const known = devices.find((d) => d.id === ref);
    return { filter: { device: ref }, label: `device ${known?.name ?? ref}` };
  }

  const hitDevices = matchRef(devices, ref);
  if (hitDevices.length === 1)
    return {
      filter: { device: hitDevices[0].id! },
      label: `device ${hitDevices[0].name}`,
    };
  if (hitDevices.length > 1)
    throw usage(
      `"${ref}" is ambiguous`,
      `it names ${hitDevices.length} devices:\n${hitDevices.map((d) => `  ${d.id}  ${d.name}`).join("\n")}`,
      "address it by its dv_… id instead",
    );

  const { areas } = await s.get<{
    areas: { id: string | null; displayName: string; legacySystemId: number }[];
  }>("/api/v4/areas");
  const hits = matchRef(
    areas.map((a) => ({ ...a, name: a.displayName })),
    ref,
  );
  if (hits.length === 1)
    return { filter: { area: hits[0].id! }, label: `area ${hits[0].name}` };
  if (hits.length > 1)
    throw usage(
      `"${ref}" is ambiguous`,
      `it names ${hits.length} areas:\n${hits.map((a) => `  ${a.id}  ${a.name}`).join("\n")}`,
      "address it by its ar_… id instead",
    );

  throw usage(
    `no device or area matches "${ref}"`,
    "a scope is resolved as a device first, then as an area, and nothing you can read matched either",
    "run `liveone device list` (or `liveone area list`) — ids are per-environment",
  );
}

/**
 * Resolve `<derivation>`: `dx_` id, else name, else ROLE.
 *
 * Role is the form an operator actually reaches for ("the ev one"), and `resolveRef` does not know
 * about it — so it is matched first, here, keeping `resolveRef`'s wording for both failure modes
 * rather than widening the shared helper with a field only this domain has.
 *
 * Ambiguity is now the EXPECTED cost of a fleet-wide listing rather than a sign of a broken config:
 * two sites both have a `generator`. So the refusal names the device set of each candidate and
 * points at `--device=`, which is the flag that makes the ref unique again.
 */
export function resolveDerivation(
  rows: WireDerivation[],
  ref: string,
  scope: string,
  byId: Map<string, WireDevice> = new Map(),
): WireDerivation {
  const byRole = rows.filter((d) => d.role === ref);
  if (byRole.length === 1) return byRole[0];
  if (byRole.length > 1)
    throw usage(
      `"${ref}" is ambiguous`,
      `it names ${byRole.length} derivations in ${scope}:\n${byRole
        .map((d) => `  ${d.id}  ${d.name}  on ${deviceNames(d, byId)}`)
        .join("\n")}`,
      "narrow it with --device=<device>, or address it by its dx_… id",
    );
  return resolveRef(rows, ref, {
    noun: "derivation",
    listCmd: "liveone derivation list",
  });
}

// ---------------------------------------------------------------------------
// Points
// ---------------------------------------------------------------------------

/**
 * Resolve a `--signal`/`--energy` value to a `pt_` id, against the device the derivation is about.
 *
 * Three forms, and the third is what the old area fan-out was really reaching for:
 *   pt_…                          an id, passed through
 *   load.ev/power                 a logical path on `<device>`
 *   daylesford:load.ev/power      a logical path on a NAMED device, anywhere you can read
 *
 * 🛑 **There is no ambiguity branch, because there is nothing left to be ambiguous.** The old form
 * fanned out over an area's members and apologised when more than one published the path; worse, it
 * could only reach the right point when both devices happened to share an area and no sibling
 * published the same path — which is exactly Daylesford's shape (signal on device 14, energy on
 * device 1). The qualified form says which device, and is checked against what that device
 * publishes.
 */
export async function resolvePoint(
  s: ApiSession,
  device: DeviceRef,
  ref: string,
  flag: string,
): Promise<string> {
  if (Point.is(ref)) return ref;

  const colon = ref.indexOf(":");
  if (colon !== -1) {
    const deviceRef = ref.slice(0, colon);
    const path = ref.slice(colon + 1);
    if (deviceRef === "" || path === "")
      throw usage(
        `"${ref}" for --${flag}`,
        "the device-qualified form is <device>:<logical-path>",
        `for example --${flag}=daylesford:load.ev/power`,
      );
    return pointOnDevice(
      s,
      deviceFromRef(await listDevices(s), deviceRef),
      path,
      flag,
    );
  }

  if (!ref.includes("/"))
    throw usage(
      `"${ref}" for --${flag}`,
      "expected a pt_… point id, a logical path, or <device>:<logical-path>",
      `a logical path looks like \`load.ev/power\` — run \`liveone device points ${device.id}\` for the ones it publishes`,
    );
  return pointOnDevice(s, device, ref, flag);
}

/**
 * The 404 from a per-device read, as a value this file can recognise again.
 *
 * `what` is the marker: `apiFetch` throws a `CliFailure` for every non-2xx, so the only way to tell
 * "that device is not in your inventory" from "the deployment fell over" is to give the one status
 * that means the former a message of our own and match on it.
 *
 * ⚠️ A per-call override preempts `apiFetch`'s protect-rewrite diagnosis, which also arrives as a
 * 404. That is acceptable HERE and only here: reaching this point required a whoami, a device
 * listing and a derivations listing to have already succeeded on the same token, so an edge rewrite
 * is not a live hypothesis by the time this call is made.
 */
const NOT_VISIBLE = {
  exit: EXIT.FINDINGS,
  what: "device-not-in-inventory",
  why: () =>
    "the per-device read applies the device listing's narrower visibility rule",
  next: "pass the pt_… id directly",
} as const;

/**
 * Resolve `--boundary` against the derivation's OWN device set.
 *
 * The boundary is the one slot a PATCH may re-point, so it has no `<device>` positional to resolve
 * against — the natural scope is the devices the derivation already touches. A path that matches on
 * none of them (or on several) is named rather than guessed at, and the qualified `<device>:<path>`
 * form reaches anywhere, which is what deliberately WIDENING the device set looks like.
 */
export async function resolveBoundaryPoint(
  s: ApiSession,
  row: WireDerivation,
  ref: string,
  byId: Map<string, WireDevice>,
): Promise<string> {
  if (Point.is(ref)) return ref;
  if (ref.includes(":")) {
    const colon = ref.indexOf(":");
    return pointOnDevice(
      s,
      deviceFromRef(await listDevices(s), ref.slice(0, colon)),
      ref.slice(colon + 1),
      "boundary",
    );
  }

  // 🛑 Iterate `row.devices`, NOT the device listing. `/api/v4/devices` serves the ACTIVE
  // owned∪granted∪public set and does not widen for admins, while a derivation is authorized
  // against every device it touches — so its set can legitimately contain a device the listing
  // omits. Skipping those would resolve a path against SOME of the derivation's devices and call
  // the answer unambiguous, which is the one outcome this function exists to prevent.
  const hits: { pointId: string; device: string }[] = [];
  const uninspectable: string[] = [];
  for (const id of row.devices) {
    // The per-device aggregate applies the SAME narrower visibility rule as the listing, so a
    // device in the set can 404 here. That is not a reason to carry on: the unseen device may
    // publish this path too, and a "match" chosen from the devices that happened to answer is the
    // silent wrong write again. Collect them and refuse below, naming the way through.
    let points: WirePoint[] = [];
    try {
      ({ points = [] } = await s.get<{ points?: WirePoint[] }>(
        `/api/v4/devices/${encodeURIComponent(id)}?include=points`,
        { errors: { 404: NOT_VISIBLE } },
      ));
    } catch (err) {
      // ONLY the 404 means "not in your device inventory". A 401, a 500 or a dead socket are
      // different facts with different fixes and their own exit codes, and diagnosing them as
      // invisibility would send the operator after a `pt_` id to work around an outage.
      if (err instanceof CliFailure && err.detail.what === NOT_VISIBLE.what) {
        uninspectable.push(byId.get(id)?.name ?? id);
        continue;
      }
      throw err;
    }
    for (const p of points)
      if (p.logicalPath === ref)
        hits.push({ pointId: p.id, device: byId.get(id)?.name ?? id });
  }
  if (uninspectable.length > 0)
    throw usage(
      `cannot read the points of ${uninspectable.join(", ")}`,
      "this derivation touches a device whose inventory is not readable through /api/v4/devices (an inactive one, or one outside your device listing), so a path cannot be resolved unambiguously across its set",
      "pass the pt_… id directly — an id needs no resolution, and `liveone derivation list --format json` shows this derivation's existing sourcePoints",
    );
  if (hits.length === 0)
    throw usage(
      `no point on ${deviceNames(row, byId)} has the logical path "${ref}"`,
      "--boundary is resolved against the devices this derivation already touches",
      "name the device explicitly (`--boundary=<device>:<path>`) to point it somewhere else — that WIDENS the device set, and the write check applies to the new device too",
    );
  if (hits.length > 1)
    throw usage(
      `"${ref}" is ambiguous across this derivation's devices`,
      `${hits.length} of them publish it:\n${hits.map((h) => `  ${h.pointId}  ${h.device}`).join("\n")}`,
      "name the device (`--boundary=<device>:<path>`), or pass the pt_… id",
    );
  return hits[0].pointId;
}
