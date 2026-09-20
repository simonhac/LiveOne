import { describe, expect, it } from "@jest/globals";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * `CardPlugin.selfSurfaced` must agree with what the card actually DRAWS.
 *
 * The rule (see `isSelfSurfaced` in components/dashboard/v4/node-view.tsx): a section child that
 * paints its own surface stands bare at the section's full width; everything else shares a padded
 * run (`SECTION_RUN_PAD`, 12px a side from `sm` up). `battery-contents` drew a `TileSurface` and
 * was NOT flagged, so it rendered 12px narrower per side than the Home Energy card beside it —
 * same shell, same padding, different wrapper. Nothing failed; you just had to notice.
 *
 * So this reads the SOURCE rather than the plugin objects: a plugin's flag is compared against
 * whether its leaf component imports a surface. That is the thing that can drift — someone adds a
 * card, renders it in a `TileSurface`, and the flag is simply never considered. Same shape as
 * scripts/check-readings-boundary.mjs: a structural invariant, checked by reading files.
 */

const ROOT = path.join(__dirname, "..", "..", "..");
const CARDS = path.join(ROOT, "components", "dashboard", "cards");

/**
 * Does this module IMPORT something that paints the one tile slab (lib/tile-style.ts's
 * `TILE_SURFACE`)?
 *
 * 🛑 Matched against the file's `import` statements only, never its whole text. Scanning the whole
 * file made a card that merely MENTIONS `TileSurface` in a comment — as LoadProvenanceCard does,
 * explaining that it has NOT moved onto one yet — read as though it drew one.
 */
const SURFACE_SYMBOLS =
  /\b(TileSurface|StatCardShell|TILE_ROOT|TILE_SURFACE)\b/;

function importsASurface(src: string): boolean {
  return [...src.matchAll(/^\s*import\s[\s\S]*?from\s+"[^"]+";/gm)].some((m) =>
    SURFACE_SYMBOLS.test(m[0]),
  );
}

/** `import X from "@/components/…"` — the leaf a card plugin delegates to. */
function leafComponents(src: string): string[] {
  return [...src.matchAll(/from\s+"@\/(components\/[^"]+)"/g)]
    .map((m) => m[1])
    .filter((p) => !p.startsWith("components/dashboard/cards/"));
}

function read(rel: string): string {
  for (const ext of ["", ".tsx", ".ts"]) {
    try {
      return readFileSync(path.join(ROOT, rel + ext), "utf8");
    } catch {
      /* try the next extension */
    }
  }
  return "";
}

const PLUGINS = readdirSync(CARDS)
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => ({ file: f, src: readFileSync(path.join(CARDS, f), "utf8") }))
  .filter(({ src }) => src.includes('kind: "card"'));

describe("self-surfaced card plugins", () => {
  it("finds the card plugins to check", () => {
    expect(PLUGINS.length).toBeGreaterThanOrEqual(10);
  });

  it.each(PLUGINS.map((p) => [p.file, p] as const))(
    "%s flags itself iff its leaf draws a surface",
    (_file, plugin) => {
      const drawsSurface = leafComponents(plugin.src).some((leaf) =>
        importsASurface(read(leaf)),
      );
      const flagged = /selfSurfaced:\s*true/.test(plugin.src);
      expect(flagged).toBe(drawsSurface);
    },
  );

  it("names the two we know about, so a silent flip to zero is visible", () => {
    const flagged = PLUGINS.filter((p) =>
      /selfSurfaced:\s*true/.test(p.src),
    ).map((p) => p.file);
    expect(flagged.sort()).toEqual(["amber-now.tsx", "battery-contents.tsx"]);
  });

  it("leaves the padded run to the things that need it — charts and tables", () => {
    const flagged = new Set(
      PLUGINS.filter((p) => /selfSurfaced:\s*true/.test(p.src)).map(
        (p) => p.file,
      ),
    );
    for (const f of [
      "chart.tsx",
      "runs.tsx",
      "heatmap.tsx",
      "daily-stripe.tsx",
    ])
      expect(flagged.has(f)).toBe(false);
  });
});
