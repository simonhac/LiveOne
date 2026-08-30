import { describe, it, expect } from "@jest/globals";
import {
  localizeInstants,
  renderMessage,
  renderMessageLike,
} from "@/lib/control/message-format";

/**
 * These assert against the LOCAL rendering of a known instant, so they must not assume a zone.
 * `expected()` spells the same instant the way `formatTime12h` would, from the test process's own
 * clock — which is the whole contract: the words follow the reader, not the hub.
 */
function expected(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours();
  const period = h >= 12 ? "pm" : "am";
  const hour = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${hour}:${String(d.getMinutes()).padStart(2, "0")}${period}`;
}

const STOP_AT = "2026-08-29T14:03:38.346Z";

describe("localizeInstants", () => {
  it("replaces the instant and leaves every other character alone", () => {
    const sentence = `Running until ${STOP_AT} — starting again extends the run.`;
    const out = localizeInstants(sentence);
    expect(out).toBe(
      `Running until ${expected(STOP_AT)} — starting again extends the run.`,
    );
    // The hub's own words, punctuation and case survive byte-for-byte.
    expect(out.startsWith("Running until ")).toBe(true);
    expect(out.endsWith(" — starting again extends the run.")).toBe(true);
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("returns a sentence with no instant unchanged", () => {
    const s =
      "the module is not in Auto (mode=Stop) — a possible local lockout at the panel, and not overridable remotely";
    expect(localizeInstants(s)).toBe(s);
  });

  it("replaces every instant when there is more than one", () => {
    const s = `started ${STOP_AT} and stops ${STOP_AT}`;
    expect(localizeInstants(s)).toBe(
      `started ${expected(STOP_AT)} and stops ${expected(STOP_AT)}`,
    );
  });

  it("handles an offset zone and a space separator", () => {
    expect(localizeInstants("at 2026-08-29T14:03:38+00:00.")).toBe(
      `at ${expected("2026-08-29T14:03:38+00:00")}.`,
    );
    expect(localizeInstants("at 2026-08-29 14:03:38Z.")).toBe(
      `at ${expected("2026-08-29T14:03:38Z")}.`,
    );
  });

  it("leaves a bare date alone — a date is not an instant", () => {
    expect(localizeInstants("on 2026-08-29 the run failed")).toBe(
      "on 2026-08-29 the run failed",
    );
  });
});

describe("renderMessage", () => {
  it("renders {name, time, short} in the reader's zone", () => {
    expect(
      renderMessage({
        template:
          "Running until {stopAt, time, short} — starting again extends the run.",
        values: { stopAt: STOP_AT },
      }),
    ).toBe(
      `Running until ${expected(STOP_AT)} — starting again extends the run.`,
    );
  });

  it("accepts epoch ms as well as ISO", () => {
    expect(
      renderMessage({
        template: "{t, time, short}",
        values: { t: Date.parse(STOP_AT) },
      }),
    ).toBe(expected(STOP_AT));
  });

  it("interpolates a bare {name}", () => {
    expect(
      renderMessage({
        template: "a {runtime}s run is longer than this generator's limit",
        values: { runtime: 3660 },
      }),
    ).toBe("a 3660s run is longer than this generator's limit");
  });

  it("leaves an unsupplied slot visible rather than writing 'undefined'", () => {
    const out = renderMessage({ template: "stop at {stopAt, time, short}" });
    expect(out).toBe("stop at {stopAt, time, short}");
    expect(out).not.toContain("undefined");
  });

  it("leaves a null value's slot visible", () => {
    expect(
      renderMessage({
        template: "stop at {stopAt, time, short}",
        values: { stopAt: null },
      }),
    ).toBe("stop at {stopAt, time, short}");
  });

  it("leaves an unsupported argument type in raw form", () => {
    expect(
      renderMessage({
        template: "{n, plural, one {run} other {runs}}",
        values: { n: 2 },
      }),
    ).toContain("{n, plural");
  });

  it("honours ICU brace escaping", () => {
    expect(
      renderMessage({ template: "'{'literal'}' and {x}", values: { x: "y" } }),
    ).toBe("{literal} and y");
  });

  it("does not re-read an escaped brace as the start of an argument", () => {
    // The whole hazard of escaping: `'{'stopAt}` must survive as literal text, not be filled in.
    expect(
      renderMessage({
        template: "'{'stopAt} is the slot for {stopAt, time, short}",
        values: { stopAt: STOP_AT },
      }),
    ).toBe(`{stopAt} is the slot for ${expected(STOP_AT)}`);
  });

  it("emits no sentinel or control character of its own", () => {
    const out = renderMessage({
      template: "'{'a'}' {x} '{'b'}'",
      values: { x: 1 },
    });
    expect(out).toBe("{a} 1 {b}");
    // A rendering strategy that swapped in placeholders could leak one on an unbalanced template.
    expect(/[\u0000-\u0008\u000e-\u001f]/.test(out)).toBe(false);
  });

  it("leaves an unbalanced quote alone rather than eating the sentence", () => {
    expect(renderMessage({ template: "cost is 5'{' each" })).toBe(
      "cost is 5{ each",
    );
  });

  it("passes a non-instant value through rather than inventing a time", () => {
    expect(
      renderMessage({
        template: "stop at {stopAt, time, short}",
        values: { stopAt: "never" },
      }),
    ).toBe("stop at never");
  });
});

describe("renderMessageLike", () => {
  it("localizes a legacy rendered string", () => {
    expect(renderMessageLike(`stop at ${STOP_AT}`)).toBe(
      `stop at ${expected(STOP_AT)}`,
    );
  });

  it("renders a structured message", () => {
    expect(
      renderMessageLike({
        template: "stop at {stopAt, time, short}",
        values: { stopAt: STOP_AT },
      }),
    ).toBe(`stop at ${expected(STOP_AT)}`);
  });

  it("is null for nothing, and for an empty sentence", () => {
    expect(renderMessageLike(null)).toBeNull();
    expect(renderMessageLike(undefined)).toBeNull();
    expect(renderMessageLike("")).toBeNull();
  });
});
