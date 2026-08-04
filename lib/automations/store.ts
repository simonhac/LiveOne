/**
 * The `automations` data layer — the one place drizzle is spoken for this table.
 *
 * Routes and the evaluator go through here so their tests mock THIS module rather than stubbing
 * bare drizzle chains (a route test that asserts on a chain is asserting on drizzle, not on us).
 * Every write stamps `updatedAt`, like the derivations PATCH does.
 */
import { and, eq, inArray } from "drizzle-orm";
import { requirePlanetscaleDb } from "@/lib/db/planetscale";
import {
  automations,
  derivations,
  type AutomationAction,
  type AutomationArmedContext,
  type AutomationMode,
  type AutomationRow,
  type AutomationTrigger,
} from "@/lib/db/planetscale/schema";

export async function listForArea(areaUuid: string): Promise<AutomationRow[]> {
  return requirePlanetscaleDb()
    .select()
    .from(automations)
    .where(eq(automations.areaId, areaUuid));
}

export async function getById(uuid: string): Promise<AutomationRow | null> {
  const [row] = await requirePlanetscaleDb()
    .select()
    .from(automations)
    .where(eq(automations.id, uuid))
    .limit(1);
  return row ?? null;
}

/**
 * Batch lookup for the command log's `automation:au_…` requesters. Rows for deleted rules are
 * simply absent — the caller falls back to anonymous wording, so this never throws on a miss.
 */
export async function getByIds(uuids: string[]): Promise<AutomationRow[]> {
  if (uuids.length === 0) return [];
  return requirePlanetscaleDb()
    .select()
    .from(automations)
    .where(inArray(automations.id, uuids));
}

export async function create(values: {
  areaId: string;
  name: string;
  mode: AutomationMode;
  trigger: AutomationTrigger;
  action: AutomationAction;
  enabled?: boolean;
}): Promise<AutomationRow> {
  const [row] = await requirePlanetscaleDb()
    .insert(automations)
    .values({
      areaId: values.areaId,
      name: values.name,
      mode: values.mode,
      trigger: values.trigger,
      action: values.action,
      enabled: values.enabled ?? true,
    })
    .returning();
  return row;
}

export type AutomationPatch = Partial<
  Pick<
    AutomationRow,
    | "name"
    | "enabled"
    | "mode"
    | "trigger"
    | "action"
    | "armedAt"
    | "armedContext"
    | "lastTriggeredRunStart"
  >
>;

/** Whole-column patch; null when the id doesn't exist. */
export async function patch(
  uuid: string,
  fields: AutomationPatch,
): Promise<AutomationRow | null> {
  const [row] = await requirePlanetscaleDb()
    .update(automations)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(automations.id, uuid))
    .returning();
  return row ?? null;
}

export async function remove(uuid: string): Promise<boolean> {
  const rows = await requirePlanetscaleDb()
    .delete(automations)
    .where(eq(automations.id, uuid))
    .returning({ id: automations.id });
  return rows.length > 0;
}

// ── Evaluator side ───────────────────────────────────────────────────────────────────────────────

export async function listEnabled(): Promise<AutomationRow[]> {
  return requirePlanetscaleDb()
    .select()
    .from(automations)
    .where(eq(automations.enabled, true));
}

export async function armAutomation(
  uuid: string,
  armedAt: Date,
  armedContext: AutomationArmedContext | null,
): Promise<void> {
  await requirePlanetscaleDb()
    .update(automations)
    .set({ armedAt, armedContext, updatedAt: new Date() })
    .where(eq(automations.id, uuid));
}

export async function disarmAutomation(
  uuid: string,
  opts: { disable: boolean },
): Promise<void> {
  await requirePlanetscaleDb()
    .update(automations)
    .set({
      armedAt: null,
      armedContext: null,
      ...(opts.disable ? { enabled: false } : {}),
      updatedAt: new Date(),
    })
    .where(eq(automations.id, uuid));
}

/**
 * Stamp a fire.
 *
 * 🛑 Deliberately does NOT clear `armedAt`/`armedContext`: a STANDING rule stays armed after
 * firing, and the point-source already-fired suppression IS `lastTriggeredRunStart === armedAt`
 * (see `decide.ts`). Clearing them here would make a standing point rule re-arm and re-fire on the
 * very next tick. The enabled-transition reset lives in the PATCH route — the only seam that sees
 * the toggle.
 */
export async function recordFired(
  uuid: string,
  opts: { firedAt: Date; anchorMs: number; disable: boolean },
): Promise<void> {
  await requirePlanetscaleDb()
    .update(automations)
    .set({
      lastTriggeredAt: opts.firedAt,
      lastTriggeredRunStart: new Date(opts.anchorMs),
      ...(opts.disable ? { enabled: false } : {}),
      updatedAt: new Date(),
    })
    .where(eq(automations.id, uuid));
}

/** The terminal `rejected` case: a refusal that is PERMANENT for this vehicle. */
export async function disableAutomation(uuid: string): Promise<void> {
  await requirePlanetscaleDb()
    .update(automations)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(automations.id, uuid));
}

/** Referential check for a derivation-sourced trigger: does this derivation belong to this area? */
export async function derivationBelongsToArea(
  derivationUuid: string,
  areaUuid: string,
): Promise<boolean> {
  const [row] = await requirePlanetscaleDb()
    .select({ id: derivations.id })
    .from(derivations)
    .where(
      and(eq(derivations.id, derivationUuid), eq(derivations.areaId, areaUuid)),
    )
    .limit(1);
  return !!row;
}
