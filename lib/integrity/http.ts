/**
 * The delete interlock every route uses: `findDependents`, then a 409 that NAMES them — one call,
 * so that no handler can forget `?force`.
 *
 * Kin to the "return a response or null" refusal contract of `checkReferences`
 * (`lib/automations/references.ts`) and `checkDocRefsReadable` (`lib/dashboard/v4-routes.ts`), and
 * deliberately one step further: it returns a DISCRIMINATED UNION, never `null`. `{response}` means
 * return that immediately; `{forced}` means proceed, and carries the list that was overridden so the
 * handler can report it. A bare `null` could not, and "I overrode three dependents" would look
 * exactly like "there was nothing to override" in the response and in the log.
 *
 * Either shape beats throwing and letting each route catch, where a route that forgets the catch
 * turns a considered refusal into a 500.
 *
 * `force` is parsed HERE rather than in each handler for the same reason. It is the difference
 * between "I did not know" and "I know and I am doing it anyway", and a delete route that read the
 * flag itself could read it inconsistently — or, worse, honour it for one interlock and not another.
 */
import { NextResponse, type NextRequest } from "next/server";
import { findDependents, type Dependent, type Subject } from "./relied-upon";

/**
 * 409 if anything still references this row, naming every dependent; `null` to proceed.
 *
 * **409, not 422.** The request is well-formed and the caller is authorized — the state of the
 * world is what makes it wrong, which is exactly the distinction 409 carries, and it matches the
 * existing refusal for deleting a device's own area.
 *
 * `?force=true` proceeds, and the caller gets the dependents back in the success body instead, so
 * that "I overrode it" and "there was nothing to override" never look the same in a log.
 */
export async function refuseIfReliedUpon(
  request: NextRequest,
  subject: Subject,
  uuid: string,
): Promise<{ response: NextResponse } | { forced: Dependent[] }> {
  const dependents = await findDependents(subject, uuid);
  if (dependents.length === 0) return { forced: [] };

  if (request.nextUrl.searchParams.get("force") === "true")
    return { forced: dependents };

  return {
    response: NextResponse.json(
      {
        error: `That ${subject} is still relied upon by ${dependents.length} thing(s)`,
        detail: {
          code: "relied-upon",
          dependents,
          fix: "resolve them, or repeat with ?force=true",
        },
      },
      { status: 409 },
    ),
  };
}
