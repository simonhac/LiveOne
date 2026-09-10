/**
 * The two area-wiring writes, and what their failures mean.
 */
import { EXIT } from "@/lib/cli/cli";
import { apiFetch } from "@/lib/cli-kit/http";
import { type ApiSession } from "@/lib/cli-kit/api-session";
import type { WireBinding, WireMember } from "./model";

export async function putBindings(
  s: ApiSession,
  areaId: string,
  bindings: WireBinding[],
): Promise<WireBinding[]> {
  const { body } = await apiFetch<{ bindings: WireBinding[] }>(
    s.origin,
    `/api/v4/areas/${encodeURIComponent(areaId)}/bindings`,
    {
      method: "PUT",
      // Carry `transform` through verbatim. It is per-binding state this CLI never sets and must
      // never drop: rewriting one slot must not quietly un-transform an untouched one.
      body: {
        bindings: bindings.map((b) => ({
          role: b.role,
          metricType: b.metricType,
          pointId: b.pointId,
          priority: b.priority,
          transform: b.transform ?? null,
        })),
      },
      token: s.token,
      errors: BINDING_ERRORS,
    },
  );
  return body.bindings;
}

export async function putMembers(
  s: ApiSession,
  areaId: string,
  deviceIds: string[],
): Promise<WireMember[]> {
  const { body } = await apiFetch<{ members: WireMember[] }>(
    s.origin,
    `/api/v4/areas/${encodeURIComponent(areaId)}/members`,
    {
      method: "PUT",
      body: { members: deviceIds },
      token: s.token,
      errors: BINDING_ERRORS,
    },
  );
  return body.members;
}

/** Both routes report a refused invariant as `{ error }` — a sentence, not a code. */
export const BINDING_ERRORS = {
  422: {
    exit: EXIT.FINDINGS,
    what: "the server refused this wiring",
    why: (b: Record<string, unknown>) => String(b.error ?? "refused"),
    next: "nothing was changed — the area is as it was",
  },
  403: {
    exit: EXIT.FINDINGS,
    what: "not your area",
    why: (b: Record<string, unknown>) => String(b.error ?? "forbidden"),
    next: "bindings are owner-or-admin; check `liveone auth whoami`",
  },
  // 🛑 A 404 here is almost never a wrong id — `loadAggregate` just resolved the area through the
  // same origin. It is the CLERK EDGE: `members`/`bindings` only became reachable with a `lo_cli_`
  // token when they joined `cliTokenRoutes`, and an older deployment 404-rewrites the request
  // before the handler sees it. The default 404 hint says "run `liveone dashboard list` — ids are
  // per-environment", which sends you hunting an id that is already correct.
  404: {
    exit: EXIT.FINDINGS,
    what: "this deployment will not accept a CLI token on the area wiring routes",
    why: () =>
      "the area resolved, so the id is right — the edge rewrote the write to a 404 before the handler ran",
    next: "check the deployed build with `liveone auth whoami`; these routes need the release that added them to cliTokenRoutes",
  },
} as const;
