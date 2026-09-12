import { NextRequest, NextResponse } from "next/server";
import { refuseIfReliedUpon } from "@/lib/integrity/http";
import { requireAuth } from "@/lib/api-auth";
import { loadAreaForAuth, type AreaAuthRow } from "@/lib/areas/http";
import { Automation } from "@/lib/ids";
import type {
  AutomationMode,
  AutomationRow,
  AutomationTrigger,
} from "@/lib/db/planetscale/schema";
import * as store from "@/lib/automations/store";
import {
  actionFromWire,
  automationWire,
  triggerFromWire,
} from "@/lib/automations/wire";
import { checkReferences } from "@/lib/automations/references";
import { refuseOnceExercise } from "@/lib/automations/types";

/**
 * One charge-limit automation.
 *
 *   PATCH  /api/v4/automations/au_… { name?, enabled?, mode?, trigger?, action? } → 200 { automation }
 *   DELETE /api/v4/automations/au_…                                              → 200 { success }
 *
 * ## Why an unauthorized id 404s rather than 403s
 *
 * There is no area in this URL, so "unknown automation" and "not your automation" must be
 * indistinguishable — otherwise the route is an oracle for which `au_` ids exist. That is the same
 * no-escalation collapse `findReadableArea` documents. `loadAreaForOwner` can 403 because the
 * caller named the area themselves.
 *
 * ## Why `trigger` and `action` are whole-object replaces
 *
 * Both are CLOSED vocabularies, not sparse config: a merge would let a caller drop `afterKwh` from
 * a stored trigger only by... not being able to. Send the object you want.
 */

const MODES: AutomationMode[] = ["once", "standing"];

function unprocessable(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 422 });
}

function notFound(): NextResponse {
  return NextResponse.json({ error: "Automation not found" }, { status: 404 });
}

/** Authenticate + resolve + authorize. Returns the row, or the response to send. */
async function loadOwnedAutomation(
  request: NextRequest,
  id: string,
): Promise<
  { row: AutomationRow; area: AreaAuthRow } | { error: NextResponse }
> {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return { error: auth };

  const uuid = Automation.toUuidOrNull(id);
  if (!uuid)
    return {
      error: NextResponse.json(
        { error: `Invalid automation id: ${id}` },
        { status: 400 },
      ),
    };

  const row = await store.getById(uuid);
  if (!row) return { error: notFound() };

  const area = await loadAreaForAuth(row.areaId);
  // Same owner-or-admin predicate `loadAreaForOwner` applies — but collapsed to 404 (see header).
  if (!area || !(auth.isAdmin || area.ownerClerkUserId === auth.userId))
    return { error: notFound() };

  return { row, area };
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const loaded = await loadOwnedAutomation(request, id);
  if ("error" in loaded) return loaded.error;
  const row = loaded.row;

  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body) return unprocessable("Body must be JSON");

  // Identity: an automation belongs to the area that authorizes it. Moving one is delete+recreate,
  // so the area-owner check above can never be evaluated against the wrong area.
  if (body.areaId !== undefined)
    return unprocessable(
      "areaId is not patchable — delete and recreate instead",
    );

  const patch: store.AutomationPatch = {};

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim() === "")
      return unprocessable("name must be a non-empty string");
    patch.name = body.name;
  }

  if (body.mode !== undefined) {
    if (
      typeof body.mode !== "string" ||
      !MODES.includes(body.mode as AutomationMode)
    )
      return unprocessable(`mode must be one of: ${MODES.join(", ")}`);
    patch.mode = body.mode as AutomationMode;
  }

  // A replaced trigger/action must clear the SAME firewalls creation did — an automation is a
  // deferred action call, dispatched later with the device owner's credentials.
  let nextTrigger = row.trigger;
  let nextAction = row.action;

  if (body.trigger !== undefined) {
    const parsed = triggerFromWire(body.trigger);
    if (!parsed.ok) return unprocessable(parsed.error);
    patch.trigger = parsed.value;
    nextTrigger = parsed.value;
  }
  if (body.action !== undefined) {
    const parsed = actionFromWire(body.action);
    if (!parsed.ok) return unprocessable(parsed.error);
    patch.action = parsed.value;
    nextAction = parsed.value;
  }
  if (body.trigger !== undefined) {
    // A baseline snapshotted against the OLD source is meaningless against the new one, and a
    // stale anchor could suppress the first fire outright.
    patch.armedAt = null;
    patch.armedContext = null;
    // For an `exercise` trigger this also clears the consumed-slot key, so a rule edited inside a
    // slot it has already dealt with can fire again for that same slot. That is the correct
    // reading of "I changed WHEN this runs" — the new schedule has never run.
    //
    // 🛑 But it is the WRONG reading of "skip next week". `skip` adds an EXDATE, and the route is a
    // whole-object replace, so it arrives here as a trigger patch like any other — and clearing
    // the key would let a slot consumed at 09:00 this morning start the engine a SECOND time at
    // 09:30, which is the exact opposite of what the owner asked for. So the key survives when the
    // instants the rule generates are unchanged (same `start`, same `rrule`) and only the
    // exceptions, the grace window or the `unless` terms moved.
    if (!sameSlotSeries(row.trigger, patch.trigger))
      patch.lastTriggeredRunStart = null;
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean")
      return unprocessable("enabled must be a boolean");
    patch.enabled = body.enabled;
    // 🛑 A CHANGE of `enabled` (false→true is the load-bearing direction) resets the arming state.
    // Without it, a standing point-source rule disabled mid-session and re-enabled during a LATER
    // session evaluates armed+active against a weeks-old `armedAt` — the minutes leg fires
    // instantly, a spurious `turn_off` at the start of the new session — with a `baselineKwh` from
    // a different cable session. `lastTriggeredRunStart` is KEPT: it preserves same-run
    // suppression for a derivation source re-enabled mid-run (the tolerance check), while the
    // fresh `armedAt` on re-arm deliberately re-qualifies a point source. Re-enabling is an
    // explicit user action: "start over". Keeping it is right for an `exercise` rule too, and for
    // a sharper reason: the slot key lives there, so re-enabling inside an already-consumed slot
    // must NOT hand the rule a second chance to start the engine.
    //
    // A SAME-VALUE write resets nothing — PR-G's enable toggle re-sending the current value must
    // not wipe a live baseline mid-session.
    if (body.enabled !== row.enabled && body.trigger === undefined) {
      patch.armedAt = null;
      patch.armedContext = null;
    }
  }

  const modeRefusal = refuseOnceExercise(patch.mode ?? row.mode, nextTrigger);
  if (modeRefusal) return unprocessable(modeRefusal);

  // 🛑 EVERY patch clears the ownership firewall, not just one that replaces trigger/action.
  //
  // The narrow version of this check (run it only when `trigger`/`action` change) guarded the wrong
  // thing: re-AIMING a rule. But an automation is a deferred command, and `enabled: false → true`
  // re-arms one that the owner had deliberately parked — the cron evaluator then dispatches it on
  // the owner's vendor credentials, with no session at all. `mode: once → standing` likewise turns
  // a spent rule into a repeating one. The area gate above admits a non-owner ADMIN, so without
  // this a non-owner admin could re-activate someone else's `turn_off` against their car.
  //
  // So the rule is the one that cannot rot: if a field can be patched, it must have cleared the
  // control gate — no per-field danger analysis, and a column added to this table later cannot
  // silently re-open the hole. The price is one extra point/device lookup on a name-only patch,
  // which is nothing next to having to re-derive "which fields can arm a command" on every change.
  // Validation-shaped 422s are deliberately answered FIRST (above): the caller already cleared the
  // area gate, so ordering leaks nothing, and a malformed body should not depend on ownership.
  //
  // DELETE is deliberately NOT gated this way — see its own note.
  const refused = await checkReferences(
    request,
    row.areaId,
    nextTrigger,
    nextAction,
  );
  if (refused) return refused;

  if (Object.keys(patch).length === 0)
    return unprocessable(
      "Nothing to patch (name | enabled | mode | trigger | action)",
    );

  const updated = await store.patch(row.id, patch);
  if (!updated) return notFound();
  return NextResponse.json({
    timezone: loaded.area.displayTimezone,
    automation: automationWire(updated, {
      timezone: loaded.area.displayTimezone,
      nowMs: Date.now(),
    }),
  });
}

/**
 * Do these two triggers generate the same series of slot INSTANTS?
 *
 * Only `start` and `rrule` decide that. EXDATE/RDATE change which of those instants survive but
 * not where they fall, and a slot already consumed stays consumed either way; `graceMinutes` and
 * `unless` are not about timing at all. Anything that is not an exercise trigger on both sides is
 * "not the same", which is the safe answer — it clears the key.
 */
function sameSlotSeries(
  before: AutomationTrigger,
  after: AutomationTrigger | undefined,
): boolean {
  if (after === undefined) return true;
  if (before.kind !== "exercise" || after.kind !== "exercise") return false;
  return (
    before.schedule.start === after.schedule.start &&
    before.schedule.rrule === after.schedule.rrule
  );
}

/**
 * Hard delete. Deliberately unlike derivations (which has no DELETE at all, because
 * `derived_intervals` CASCADE would destroy years of output): an automation owns no derived rows,
 * and `point_commands.requested_by` is a plain string with no FK, so the audit trail of everything
 * this rule ever did survives the rule itself.
 *
 * 🛑 **DELETE is ADMINISTRATION, not a command — so it stays area-owner-OR-ADMIN and does NOT run
 * `checkReferences`.** The owner-only rule is "only the device owner may cause a command to be
 * SENT". Deleting an automation can only ever cause FEWER commands: it removes a deferred action,
 * it cannot arm, re-aim or re-time one. The failure mode is a rule that stops firing (a charge that
 * runs past its limit) — an availability loss, not an action taken on someone else's car with that
 * owner's credentials, and one an admin can already cause a dozen other ways (disabling a device,
 * revoking a token). Gating it on device ownership would also mean an admin could not clear an
 * automation belonging to a device whose owner has left, which is a real administrative need.
 * PATCH cannot be argued the same way precisely because PATCH can arm.
 *
 * `refuseIfReliedUpon` is wired here even though NOTHING references an automation today, and it is
 * wired for exactly that reason: the gate is the place the next reference has to be declared. An
 * empty finder that is called is a question with the answer "none"; a finder nobody calls is a
 * question nobody asked, which is how `automations.trigger` came to reference a derivation for a
 * year with no FK and no check. (`point_commands.requested_by` holds `automation:au_…` and is
 * deliberately not counted — an audit row must outlive what it audited.)
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const loaded = await loadOwnedAutomation(request, id);
  if ("error" in loaded) return loaded.error;

  const relied = await refuseIfReliedUpon(request, "automation", loaded.row.id);
  if ("response" in relied) return relied.response;

  const removed = await store.remove(loaded.row.id);
  if (!removed) return notFound();
  return NextResponse.json({ success: true, forced: relied.forced });
}
