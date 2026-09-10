/**
 * The `derivation` domain's shared vocabulary and resolution.
 *
 * The arg shapes, the enums that MIRROR server-side registries (kept as literals here for the same
 * reason `runsConfigSchema` keeps one — deriving them would drag the role registry into the CLI
 * bundle), the wire types, and the two-step area→derivation resolution every verb starts with.
 */
import { num, type Ctx } from "@/lib/cli/cli";
import { type ApiSession } from "@/lib/cli-kit/api-session";
import { Point } from "@/lib/ids";
import { resolveRef, usage } from "../shared";

export const AREA_ARG = {
  name: "area",
  required: true,
  help: "An area: its ar_… id, integer handle, or display name",
} as const;

export const DERIVATION_ARG = {
  name: "derivation",
  required: true,
  help: "A derivation on that area: its dx_… id, its name, or its role",
} as const;

/** The two `derivations.kind` values this build knows. Mirrors lib/derivations/resolve.ts. */
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

export interface WireArea {
  id: string | null;
  displayName: string;
  legacySystemId: number | null;
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

/** List + resolve, shared by every verb. The same two steps `liveone area` uses. */
export async function resolveArea(
  s: ApiSession,
  ref: string,
): Promise<WireArea> {
  const { areas } = await s.get<{ areas: WireArea[] }>("/api/v4/areas");
  return resolveRef(
    areas.map((a) => ({ ...a, name: a.displayName })),
    ref,
    { noun: "area", listCmd: "liveone area list" },
  );
}

export async function listDerivations(
  s: ApiSession,
  area: WireArea,
): Promise<WireDerivation[]> {
  const { derivations } = await s.get<{ derivations: WireDerivation[] }>(
    `/api/v4/areas/${encodeURIComponent(area.id!)}/derivations`,
  );
  return derivations;
}

/**
 * Resolve `<derivation>` within an area: `dx_` id, else name, else ROLE.
 *
 * Role is the form an operator actually reaches for ("the ev one"), and `resolveRef` does not know
 * about it — so it is matched first, here, keeping `resolveRef`'s wording for both failure modes
 * rather than widening the shared helper with a field only this domain has.
 */
export function resolveDerivation(
  rows: WireDerivation[],
  ref: string,
  area: WireArea,
): WireDerivation {
  const byRole = rows.filter((d) => d.role === ref);
  if (byRole.length === 1) return byRole[0];
  if (byRole.length > 1)
    throw usage(
      `"${ref}" is ambiguous`,
      `it names ${byRole.length} derivations on ${area.displayName}:\n${byRole.map((h) => `  ${h.id}  ${h.name}`).join("\n")}`,
      "address it by its dx_… id instead",
    );
  return resolveRef(rows, ref, {
    noun: "derivation",
    listCmd: `liveone derivation list ${area.id}`,
  });
}

/**
 * Resolve a `--signal`/`--energy` value to a `pt_` id: passed through if it already is one, else
 * matched as a LOGICAL PATH across the area's member devices.
 *
 * The path form is the one to use. A detector bound to the wrong point does not error — it just
 * never fires, or fires on the wrong thing, and the only symptom is an empty card weeks later. A
 * path (`load.ev/power`) says what you meant and is checked here against what the devices actually
 * publish; a hand-copied uuid says nothing and is checked against nothing.
 */
export async function resolvePoint(
  s: ApiSession,
  area: WireArea,
  ref: string,
  flag: string,
): Promise<string> {
  if (Point.is(ref)) return ref;
  if (!ref.includes("/"))
    throw usage(
      `"${ref}" for --${flag}`,
      "expected a pt_… point id or a logical path",
      `a logical path looks like \`load.ev/power\` — run \`liveone area show ${area.id}\` for the members, then \`liveone device points <device>\``,
    );

  const { members } = await s.get<{ members: { id: string; name: string }[] }>(
    `/api/v4/areas/${encodeURIComponent(area.id!)}`,
  );
  const hits: { pointId: string; device: string; unit: string | null }[] = [];
  for (const m of members) {
    const { points = [] } = await s.get<{ points?: WirePoint[] }>(
      `/api/v4/devices/${encodeURIComponent(m.id)}?include=points`,
    );
    for (const p of points)
      if (p.logicalPath === ref)
        hits.push({ pointId: p.id, device: m.name, unit: p.unit });
  }

  if (hits.length === 0)
    throw usage(
      `no point on ${area.displayName} has the logical path "${ref}"`,
      "the detector would have nothing to follow",
      `run \`liveone device points <device>\` for the paths this site publishes`,
    );
  if (hits.length > 1)
    throw usage(
      `"${ref}" is ambiguous on ${area.displayName}`,
      `${hits.length} members publish it:\n${hits.map((h) => `  ${h.pointId}  ${h.device}`).join("\n")}`,
      "pass the pt_… id of the one you mean",
    );
  return hits[0].pointId;
}
