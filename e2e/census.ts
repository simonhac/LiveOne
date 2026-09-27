/**
 * The computed-colour census — what makes "this change is a pure rename" evidence rather than
 * argument (docs/architecture/colour-tokens.md § "Verifying a change").
 *
 * It walks the card subtrees of `/labs/card-gallery`, reads every colour the browser actually
 * computed, and normalises each to sRGB bytes + alpha. Computed values are resolved absolutes, so
 * `oklch(...)`, `rgb(...)` and Tailwind's `color-mix(in oklab, ...)` all collapse to the same
 * representation and a rename diffs to nothing.
 *
 * 🛑 THREE THINGS THAT SILENTLY PRODUCE A USELESS CENSUS. Each of these fails by returning less
 * data rather than by erroring, which is the expensive direction for a guard:
 *
 *  1. CANVAS COMPOSITING PREMULTIPLIES ALPHA. Painting `rgba(255,255,255,0.55)` onto a 1x1 canvas
 *     and reading it back gives an OPAQUE mid-grey, which collides with a genuinely opaque tone —
 *     destroying exactly the distinction between `tile-ink-muted` and a solid colour. The original
 *     by-hand census got away with it because it only ever compared like against like; it is wrong
 *     for the "every colour is a token" assertion. So we solve for alpha with TWO backdrops.
 *  2. `borderColor` IS A SHORTHAND and computes to "" whenever the four sides differ. Read the four
 *     longhands, or every asymmetric border vanishes from the record without trace.
 *  3. GRADIENTS ARE INVISIBLE to a `backgroundColor` read. Amber's price levels are
 *     `radial-gradient(...)` (lib/amber-utils.ts) — the whole AmberNow hero and Amber's price pill.
 *     Their stops are already resolved `rgb()`, so we parse them out of `backgroundImage`.
 */
import type { Page } from "@playwright/test";

/** A normalised colour: "r,g,b,a" with alpha to 3dp. Fully transparent is dropped, not recorded. */
export type Rgba = string;

export interface Census {
  section: string;
  /** Elements visited inside `[data-card-case]` subtrees — a determinism tripwire, not a finding. */
  elementCount: number;
  /** property -> "r,g,b,a" -> how many elements carried it. */
  colours: Record<string, Record<Rgba, number>>;
  /** One example per (property, colour), for a legible failure. Never committed. */
  samples: Record<string, { selector: string; text: string }>;
}

/**
 * The in-page half. Kept as one string evaluated in the browser so the normaliser used for the
 * OBSERVED colours and the one used for the EXPECTED palette are literally the same code — two
 * implementations would differ in rounding and the diff would be noise.
 */
const IN_PAGE = `(() => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  /** Paint \`css\` over a known backdrop and read the composited byte triple. */
  function over(css, backdrop) {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = backdrop;
    ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    return ctx.getImageData(0, 0, 1, 1).data;
  }

  /**
   * "r,g,b,a" for any CSS colour string, or null when it is not a colour / fully transparent.
   *
   * Two backdrops, because the canvas composites alpha away. Over black a channel reads a*c; over
   * white it reads a*c + (1-a)*255. Subtracting: white - black = (1-a)*255, so a = 1 - (w-b)/255,
   * taken as the MEDIAN of the three channels to shrug off rounding. Then un-premultiply against
   * black for the colour itself.
   */
  function norm(css) {
    if (!css || css === "none" || css === "transparent") return null;
    let b, w;
    try {
      b = over(css, "#000");
      w = over(css, "#fff");
    } catch {
      return null;
    }
    const alphas = [0, 1, 2].map((i) => 1 - (w[i] - b[i]) / 255);
    alphas.sort((x, y) => x - y);
    let a = alphas[1];
    if (a <= 0.0005) return null;
    if (a > 1) a = 1;
    const chan = (i) => Math.round(Math.min(255, Math.max(0, b[i] / a)));
    const round3 = Math.round(a * 1000) / 1000;
    return chan(0) + "," + chan(1) + "," + chan(2) + "," + round3;
  }

  return { norm, over };
})()`;

/** A stable-ish CSS path for an element, for error messages only. */
const SELECTOR_FN = `(el) => {
  const bits = [];
  let n = el;
  while (n && n.nodeType === 1 && bits.length < 4) {
    let s = n.tagName.toLowerCase();
    const cls = (n.getAttribute("class") || "").trim().split(/\\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) s += "." + cls.join(".");
    bits.unshift(s);
    n = n.parentElement;
  }
  return bits.join(" > ");
}`;

/**
 * Census every `[data-card-case]` subtree currently on the page.
 *
 * Scoped to those subtrees on purpose: this page's own chrome is NOT in the colour gate's SCOPE and
 * is deliberately full of raw palette classes, so a whole-document census would mix ~100 elements
 * that are supposed to be literals in with the cards under test.
 */
export async function censusSection(
  page: Page,
  section: string,
): Promise<Census> {
  const raw = await page.evaluate(
    ({ inPage, selectorFn }) => {
      const { norm } = eval(inPage) as { norm: (css: string) => string | null };
      const sel = eval(selectorFn) as (el: Element) => string;

      const PROPS = [
        "color",
        "backgroundColor",
        "borderTopColor",
        "borderRightColor",
        "borderBottomColor",
        "borderLeftColor",
        "fill",
        "stroke",
      ] as const;

      const colours: Record<string, Record<string, number>> = {};
      const samples: Record<string, { selector: string; text: string }> = {};
      let elementCount = 0;

      const bump = (prop: string, rgba: string, el: Element) => {
        (colours[prop] ??= {})[rgba] = ((colours[prop] ??= {})[rgba] ?? 0) + 1;
        const key = prop + "|" + rgba;
        if (!samples[key])
          samples[key] = {
            selector: sel(el),
            text: (el.textContent || "").trim().slice(0, 40),
          };
      };

      for (const root of document.querySelectorAll("[data-card-case]")) {
        for (const el of [root, ...root.querySelectorAll("*")]) {
          elementCount++;
          const cs = getComputedStyle(el);
          for (const prop of PROPS) {
            const v = norm(cs[prop as keyof CSSStyleDeclaration] as string);
            if (v) bump(prop, v, el);
          }
          // Gradients: the stops are already resolved rgb(), so pull them out of backgroundImage.
          const bg = cs.backgroundImage;
          if (bg && bg !== "none") {
            for (const m of bg.matchAll(
              /rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}|oklch\([^)]*\)/g,
            )) {
              const v = norm(m[0]);
              if (v) bump("backgroundImage", v, el);
            }
          }
        }
      }
      return { colours, samples, elementCount };
    },
    { inPage: IN_PAGE, selectorFn: SELECTOR_FN },
  );

  return { section, ...raw };
}

/**
 * Every colour the dashboard is ALLOWED to render, resolved by the browser itself.
 *
 * 🛑 Resolved in-page on purpose. Re-implementing oklch -> sRGB in Node would be a second
 * implementation of the exact conversion this layer exists to get right, and any disagreement
 * between the two would show up as a fake finding.
 *
 * @param tokenNames `--color-*` names parsed out of app/globals.css
 * @param literals   legitimate non-token colours (CHART_COLORS, role rgb fields, brand inks) and
 *                   the gate's EXEMPTIONS, as raw CSS colour strings or class names
 */
export async function expectedPalette(
  page: Page,
  tokenNames: string[],
  literals: string[],
): Promise<Set<Rgba>> {
  const list = await page.evaluate(
    ({ inPage, tokenNames, literals }) => {
      const { norm } = eval(inPage) as { norm: (css: string) => string | null };
      const probe = document.createElement("span");
      probe.style.position = "fixed";
      probe.style.left = "-9999px";
      document.body.appendChild(probe);

      const out: string[] = [];
      for (const name of tokenNames) {
        probe.style.color = "";
        probe.style.color = `var(${name})`;
        const v = norm(getComputedStyle(probe).color);
        if (v) out.push(v);
      }
      for (const lit of literals) {
        probe.className = "";
        probe.style.color = "";
        if (/^[a-z-]+-[a-z0-9/[\]().-]+$/i.test(lit) && !lit.includes("(")) {
          // A utility class — let the SHIPPED css resolve it (the role-chrome.test.ts trick).
          probe.className = lit.startsWith("text-") ? lit : `text-${lit}`;
        } else {
          probe.style.color = lit;
        }
        const v = norm(getComputedStyle(probe).color);
        if (v) out.push(v);
      }
      probe.remove();
      return out;
    },
    { inPage: IN_PAGE, tokenNames, literals },
  );
  return new Set(list);
}

/** Merge `b` into `a` (unioning colours, summing counts, keeping the first sample). */
export function mergeCensus(a: Census, b: Census): Census {
  const colours: Record<string, Record<string, number>> = { ...a.colours };
  for (const [prop, byColour] of Object.entries(b.colours)) {
    colours[prop] = { ...(colours[prop] ?? {}) };
    for (const [rgba, n] of Object.entries(byColour))
      colours[prop][rgba] = (colours[prop][rgba] ?? 0) + n;
  }
  return {
    section: a.section,
    elementCount: a.elementCount + b.elementCount,
    colours,
    samples: { ...b.samples, ...a.samples },
  };
}

/** `(property, colour)` pairs, sorted — the part the baseline asserts. */
export function keySet(c: Census): string[] {
  return Object.entries(c.colours)
    .flatMap(([prop, byColour]) =>
      Object.keys(byColour).map((rgba) => `${prop}|${rgba}`),
    )
    .sort();
}

/** Colours in the census that are not in `allowed`, with one example each. */
export function unknownColours(
  c: Census,
  allowed: Set<Rgba>,
): { property: string; colour: Rgba; selector: string; text: string }[] {
  const out: {
    property: string;
    colour: Rgba;
    selector: string;
    text: string;
  }[] = [];
  for (const [property, byColour] of Object.entries(c.colours))
    for (const colour of Object.keys(byColour)) {
      if (allowed.has(colour)) continue;
      const s = c.samples[`${property}|${colour}`];
      out.push({
        property,
        colour,
        selector: s?.selector ?? "?",
        text: s?.text ?? "",
      });
    }
  return out.sort((x, y) => (x.colour < y.colour ? -1 : 1));
}

/** The committed artefact: counts kept as evidence, `samples` dropped (they are path-dependent). */
export function toBaseline(c: Census): {
  section: string;
  elementCount: number;
  colours: Record<string, Record<string, number>>;
} {
  const colours: Record<string, Record<string, number>> = {};
  for (const prop of Object.keys(c.colours).sort()) {
    colours[prop] = {};
    for (const rgba of Object.keys(c.colours[prop]).sort())
      colours[prop][rgba] = c.colours[prop][rgba];
  }
  return { section: c.section, elementCount: c.elementCount, colours };
}
