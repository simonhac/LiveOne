/**
 * Wire shapes for the config-v4 derivations resource (`/api/v4/derivations`).
 *
 * A derivation is stored with one kind-specific jsonb column of knobs (`params`, SPARSE) and a set
 * of typed input ports in `derivation_sources` (migration 0063).
 *
 * 🛑 **The projection reads the ROWS, not `derivations.source_points`.** The jsonb is still WRITTEN
 * — 0064 drops it — but nothing reads it to learn a derivation's wiring any more, including this
 * file. (`lib/integrity/ledger.ts` still knows how to EXTRACT the uuids from it, which is the
 * census's job of classifying every column that could hold a reference, not a use of the value.)
 * It used to be read
 * here on the grounds that it was "still the wire shape", which made the wire show the unenforced
 * copy of the wiring while the engines acted on the enforced one; the two are kept in step inside
 * one transaction by every writer, but "kept in step by discipline" is a strictly worse thing to
 * show a caller than the side the database checks. The wire KEY is unchanged (`sourcePoints`), so
 * this is not a wire break — only a change of which column answers it.
 *
 * The wire speaks TypeIDs like the rest of `/api/v4`, so point uuids cross as `pt_` and device
 * uuids as `dv_`. The slot projection is per-kind and explicit rather than "encode anything
 * uuid-shaped": a future kind whose slots mean something else would be silently mislabelled by the
 * generic version, and the failure would surface as a "point not found" a long way from here.
 *
 * `params` crosses verbatim. It is genuinely open (each kind's own knobs, sparse by convention) and
 * holds no identities, so there is nothing to translate — validating it is the writer's job
 * (`ensureRunDetector` rejects a detector with no threshold bound), not the codec's.
 */
import { Derivation, Point } from "@/lib/ids";
import { HWS_MODEL_KIND, RUN_DETECTOR_KIND } from "./kinds";
import type { DerivationRecord } from "./scope";

/**
 * Project a derivation's source rows onto its kind's slot vocabulary.
 *
 * Every slot the kind HAS is emitted, `null` when unwired — the caller can then tell "this kind has
 * no boundary" from "this detector has no boundary set", which an omitted key cannot. `boundary` in
 * particular was write-only until this projection moved onto the rows: PATCH permits re-pointing it
 * and the old jsonb projection then refused to show the result back.
 */
function sourcePointsWire(
  kind: string,
  sources: { slot: string; pointId: string }[],
): Record<string, string | null> {
  const bySlot = new Map(sources.map((s) => [s.slot, s.pointId]));
  const pt = (slot: string) => {
    const uuid = bySlot.get(slot);
    return uuid ? Point.encode(uuid) : null;
  };
  if (kind === RUN_DETECTOR_KIND)
    return {
      signal: pt("signal"),
      energy: pt("energy"),
      boundary: pt("boundary"),
    };
  if (kind === HWS_MODEL_KIND) return { power: pt("power") };
  // An unknown kind is served with its sources withheld rather than guessed at — the row is still
  // listed (so it can be seen, disabled and deleted) but nothing claims to know what its slots mean.
  return {};
}

/**
 * The wire shape of one derivation.
 *
 * `devices` is the addition PR 3 makes, and it is not decoration: it is the set the request was
 * AUTHORIZED against (see `lib/derivations/scope.ts`), so a caller can see why a 403 named what it
 * named, and the CLI can render "this detector touches handles 1 and 14" without a second lookup.
 */
export function derivationWire(rec: DerivationRecord) {
  const row = rec.row;
  return {
    id: Derivation.encode(row.id),
    kind: row.kind,
    role: row.role,
    name: row.name,
    enabled: row.enabled,
    output: row.output,
    outputPointId: row.outputPointId ? Point.encode(row.outputPointId) : null,
    params: row.params ?? {},
    sourcePoints: sourcePointsWire(row.kind, rec.sources),
    devices: rec.devices.map((d) => d.deviceId),
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
