/**
 * Wire shapes for the config-v4 derivations resource (`/api/v4/areas/{ar_}/derivations`).
 *
 * A derivation is stored with two kind-specific jsonb columns — `params` (behaviour knobs, SPARSE)
 * and `source_points` (raw `points.id` uuids). The wire speaks TypeIDs like the rest of `/api/v4`, so
 * the uuids in `source_points` cross as `pt_` ids. That translation is per-kind and explicit rather
 * than a "encode anything uuid-shaped" sweep: a future kind whose source_points carries a non-point
 * uuid would be silently mislabelled by the generic version, and the failure would surface as a
 * "point not found" a long way from here.
 *
 * `params` crosses verbatim. It is genuinely open (each kind's own knobs, sparse by convention) and
 * holds no identities, so there is nothing to translate — validating it is the writer's job
 * (`ensureRunDetector` rejects a detector with no threshold bound), not the codec's.
 */
import { Derivation, Point } from "@/lib/ids";
import { HWS_MODEL_KIND, RUN_DETECTOR_KIND } from "./resolve";

/** The `derivations` columns the wire shape is built from. */
export interface DerivationRowFacts {
  id: string;
  kind: string;
  role: string | null;
  name: string;
  enabled: boolean;
  output: string;
  outputPointId: string | null;
  params: unknown;
  sourcePoints: unknown;
}

/** Encode a stored `source_points` object's point uuids as `pt_` TypeIDs. */
function sourcePointsWire(kind: string, raw: unknown): Record<string, unknown> {
  const src = (raw ?? {}) as Record<string, unknown>;
  const pt = (v: unknown) => (typeof v === "string" ? Point.encode(v) : null);
  if (kind === RUN_DETECTOR_KIND)
    return { signal: pt(src.signal), energy: pt(src.energy) };
  if (kind === HWS_MODEL_KIND) return { power: pt(src.power) };
  // An unknown kind is served with its source_points withheld rather than guessed at — the row is
  // still listed (so it can be seen and disabled) but nothing claims to know what its uuids mean.
  return {};
}

export function derivationWire(row: DerivationRowFacts) {
  return {
    id: Derivation.encode(row.id),
    kind: row.kind,
    role: row.role,
    name: row.name,
    enabled: row.enabled,
    output: row.output,
    outputPointId: row.outputPointId ? Point.encode(row.outputPointId) : null,
    params: row.params ?? {},
    sourcePoints: sourcePointsWire(row.kind, row.sourcePoints),
  };
}

/**
 * Decode a `pt_` TypeID from an untrusted body, or null when absent/malformed.
 *
 * Callers distinguish "absent" from "malformed" themselves (a missing optional energy point is
 * legal; a garbled one is a 422), so this deliberately collapses only the *decode* outcome.
 */
export function pointUuidFromWire(v: unknown): string | null {
  return typeof v === "string" ? Point.toUuidOrNull(v) : null;
}
