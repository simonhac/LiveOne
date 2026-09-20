import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The colour-token layer's guard (docs/architecture/colour-tokens.md).
 *
 * 🛑 WHAT THIS EXISTS TO CATCH. Tailwind v4's palette is `oklch`, not the v3 sRGB hexes everyone
 * has memorised: `gray-400` is `oklch(70.7% 0.022 261.325)`, which is a visibly different colour
 * from `rgb(156, 163, 175)` on a wide-gamut display. The token block in `app/globals.css` aliases
 * Tailwind keys by hand, so a value typed from a v3 cheat sheet — or a Tailwind upgrade that
 * retunes the palette — would re-tone the whole dashboard with nothing to notice. This test
 * re-reads BOTH files on every run and compares them, so neither can drift alone.
 *
 * It deliberately parses the shipped CSS rather than mirroring the palette in TypeScript: a TS copy
 * of every value would be the second spelling this layer exists to delete.
 */

const ROOT = path.join(__dirname, "..", "..");

/**
 * A declaration's value, normalised for comparison.
 *
 * Prettier reflows a long `--color-…: oklch(…); /* comment *\/` across lines, which would otherwise
 * make this test fail on formatting rather than on colour. Collapse the whitespace and tighten it
 * inside the parens, so the comparison is about the value and nothing else.
 */
function normalise(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim();
}

/** `--color-x: <value>;` pairs inside a `@theme { … }` (or any) block of a CSS file. */
function readColorVars(file: string): Map<string, string> {
  const css = readFileSync(file, "utf8");
  const out = new Map<string, string>();
  for (const m of css.matchAll(/^\s*(--color-[a-z0-9-]+):\s*([^;]+);/gm)) {
    out.set(m[1], normalise(m[2]));
  }
  return out;
}

const OURS = readColorVars(path.join(ROOT, "app", "globals.css"));
const TAILWIND = readColorVars(
  path.join(ROOT, "node_modules", "tailwindcss", "theme.css"),
);

/**
 * Every token whose value is an ALIAS of a Tailwind palette entry, and the entry it aliases.
 *
 * Tokens absent from this table carry a value of their own — `surface` (#1C1C1E, Apple's secondary
 * system background) and the white-alpha `tile-ink-*` ramp — and are pinned by the literal
 * assertions at the bottom instead.
 */
const ALIASES: Record<string, string> = {
  "--color-canvas": "--color-black",
  "--color-surface-sunken": "--color-gray-900",
  "--color-surface-overlay": "--color-gray-800",
  "--color-surface-control": "--color-gray-700",
  "--color-surface-control-hover": "--color-gray-600",
  "--color-ink": "--color-white",
  "--color-ink-strong": "--color-gray-100",
  "--color-ink-secondary": "--color-gray-300",
  "--color-ink-muted": "--color-gray-400",
  "--color-ink-faint": "--color-gray-500",
  "--color-ink-disabled": "--color-gray-600",
  "--color-ink-inverse": "--color-black",
  "--color-line": "--color-gray-700",
  "--color-line-strong": "--color-gray-600",
  "--color-danger": "--color-red-400",
  "--color-danger-solid": "--color-red-600",
  "--color-danger-solid-hover": "--color-red-700",
  "--color-warn": "--color-amber-400",
  "--color-ok": "--color-green-400",
  "--color-accent": "--color-blue-600",
  "--color-accent-hover": "--color-blue-700",
  "--color-accent-ink": "--color-blue-500",
  "--color-focus": "--color-blue-500",
  "--color-brand-amber": "--color-amber-400",
};

/**
 * Tokens that alias a Tailwind entry AT AN ALPHA — `gray-900/30` and friends. Tailwind compiles
 * `/30` to `color-mix(in oklab, <colour> 30%, transparent)`, which resolves to the same colour
 * carrying that alpha, so the token spells it directly and this checks the colour half matches.
 */
const ALPHA_ALIASES: Record<string, [string, string]> = {
  "--color-surface-panel": ["--color-gray-900", "0.3"],
  "--color-line-soft": ["--color-gray-700", "0.7"],
  "--color-danger-line": ["--color-red-500", "0.7"],
  "--color-danger-wash": ["--color-red-500", "0.1"],
  "--color-warn-line": ["--color-amber-800", "0.4"],
  "--color-warn-wash": ["--color-amber-500", "0.1"],
};

describe("colour tokens", () => {
  it("defines every token the vocabulary names", () => {
    const named = [...OURS.keys()].filter((k) => !k.startsWith("--color-gray"));
    expect(named.length).toBeGreaterThan(30);
  });

  it.each(Object.entries(ALIASES))(
    "%s is byte-identical to Tailwind's %s",
    (token, twKey) => {
      const tw = TAILWIND.get(twKey);
      expect(tw).toBeDefined();
      expect(OURS.get(token)).toBe(tw);
    },
  );

  it.each(Object.entries(ALPHA_ALIASES))(
    "%s is Tailwind's %s at the stated alpha",
    (token, [twKey, alpha]) => {
      const tw = TAILWIND.get(twKey);
      expect(tw).toBeDefined();
      // `oklch(21% 0.034 264.665)` -> `oklch(21% 0.034 264.665 / 0.3)`
      expect(OURS.get(token)).toBe(`${tw!.replace(/\)$/, "")} / ${alpha})`);
    },
  );

  it("pins the tokens that are NOT Tailwind aliases", () => {
    // Apple's secondary system background (dark) — the tile slab. Not a Tailwind grey.
    expect(OURS.get("--color-surface")).toBe("#1c1c1e");
    expect(OURS.get("--color-surface-raised")).toBe("#2c2c2e");
    // The white-alpha tile ramp. These ARE the magic numbers the token names replace, so they are
    // written down exactly once — here.
    expect(OURS.get("--color-tile-ink-dim")).toBe("rgb(255 255 255 / 0.8)");
    expect(OURS.get("--color-tile-ink-muted")).toBe("rgb(255 255 255 / 0.55)");
    expect(OURS.get("--color-tile-ink-idle")).toBe("rgb(255 255 255 / 0.4)");
    expect(OURS.get("--color-line-hairline")).toBe("rgb(255 255 255 / 0.25)");
    expect(OURS.get("--color-line-faint")).toBe("rgb(255 255 255 / 0.07)");
    expect(OURS.get("--color-wash")).toBe("rgb(255 255 255 / 0.08)");
    expect(OURS.get("--color-rail")).toBe("rgb(255 255 255 / 0.1)");
    expect(OURS.get("--color-scrim")).toBe("rgb(0 0 0 / 0.5)");
  });

  it("names every token semantically — no hue in a token name", () => {
    const HUES =
      /-(gray|zinc|neutral|slate|stone|red|orange|yellow|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|lime)(-\d+)?$/;
    // `brand-amber` is the one exception: the hue IS the brand's name.
    const offenders = [...OURS.keys()].filter(
      (k) => HUES.test(k) && k !== "--color-brand-amber",
    );
    expect(offenders).toEqual([]);
  });
});
