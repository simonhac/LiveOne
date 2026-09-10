/**
 * The route adapter for `assertNotReliedUpon` — one call, so that no handler can forget `?force`.
 *
 * Same "return a response or null" refusal contract as `checkReferences` (`lib/automations/`) and
 * `checkDocRefsReadable` (`lib/dashboard/v4-routes.ts`): a handler either gets a response to return
 * immediately, or `null` meaning proceed. The contract matters here more than usual — the
 * alternative shape (throw, and let each route catch) is one where a route that forgets the catch
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
