import { describe, it, expect } from "@jest/globals";
import { reliedUponDependents, reliedUponMessage } from "../message";

/**
 * The UI renderer. Its job is to stop a delete dialog showing "still relied upon by 3 thing(s)" —
 * the anonymous count the whole mechanism exists to replace — at the one place a person meets it.
 */
const body = (dependents: unknown[]) => ({
  error: `still relied upon by ${dependents.length} thing(s)`,
  detail: { code: "relied-upon", dependents },
});

const dep = (over: Record<string, unknown> = {}) => ({
  kind: "dashboard",
  id: "db_01aaaaaaaaaaaaaaaaaaaaaaaa",
  name: "Home",
  via: "dashboards.doc → node.area",
  effect: "silently-dropped",
  fix: "re-point that node",
  ...over,
});

describe("reliedUponMessage", () => {
  it("names each dependent and says what happens to it, in words", () => {
    const out = reliedUponMessage(
      body([dep(), dep({ kind: "user", name: null, effect: "cleared" })]),
    );
    expect(out).toContain("This would affect 2 thing(s):");
    expect(out).toContain("• dashboard “Home” — it references this");
    // An unnamed dependent renders without an empty gap where the name would be.
    expect(out).toContain("• user — their setting would be emptied");
  });

  it("returns null for any other refusal, so the caller falls back to body.error", () => {
    expect(
      reliedUponMessage({ error: "That shortname is already in use" }),
    ).toBeNull();
    expect(reliedUponMessage({ error: "Forbidden" })).toBeNull();
    // A relied-upon shape with an empty list is not a refusal worth rendering.
    expect(reliedUponMessage(body([]))).toBeNull();
  });

  it("tolerates rubbish rather than throwing inside an error handler", () => {
    for (const junk of [null, undefined, 0, "", [], {}, { detail: 7 }])
      expect(reliedUponMessage(junk)).toBeNull();
  });

  it("covers every effect in the vocabulary", () => {
    // A new `Effect` member with no case would render `undefined` into the dialog.
    for (const effect of [
      "silently-dropped",
      "cleared",
      "dangles",
      "cascade-deleted",
      "loses-access",
    ]) {
      const out = reliedUponMessage(body([dep({ effect })]));
      expect(out).not.toContain("undefined");
      expect(out?.split("\n")[1]?.length).toBeGreaterThan(15);
    }
  });

  it("exposes the raw list too, for a caller that wants to render it structurally", () => {
    expect(reliedUponDependents(body([dep()]))?.[0].via).toBe(
      "dashboards.doc → node.area",
    );
  });
});
