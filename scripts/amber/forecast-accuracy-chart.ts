/**
 * Chart for `forecast-accuracy.ts` — error vs lead time, one line per Amber channel.
 *
 * Three small multiples sharing the x axis (lead hours): mean absolute error, p90 absolute error,
 * and bias. All three are c/kWh, but they answer different questions and deserve their own y
 * scales, so they are faceted rather than crammed onto one plot — never a second y axis.
 *
 * The SVG is built directly (d3-scale + d3-shape, no DOM) and always written; the PNG is a
 * rasterisation of it via puppeteer, which is skipped with a warning if a browser can't launch.
 * Ops tooling that hard-fails on a missing chart engine is tooling people stop running.
 *
 * Palette: categorical slots 1-2 of the house data-viz palette (#2a78d6 blue, #eb6834 orange),
 * validated for CVD separation and contrast against the light surface. Series identity is carried
 * by a legend AND a direct label on the last point, never by colour alone.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { scaleLinear } from "d3-scale";
import { area as d3area, line as d3line } from "d3-shape";

export interface ChartPoint {
  lead: number;
  mae: number;
  p90: number;
  bias: number;
  /** s.d. of the absolute errors — half-width of the band around `mae`. */
  maeSd: number;
  /** s.d. of the signed errors — half-width of the band around `bias`. */
  biasSd: number;
}

export interface ChartSeries {
  channel: string;
  points: ChartPoint[];
}

export interface ChartSpec {
  title: string;
  subtitle: string;
  series: ChartSeries[];
}

const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a"];
const SURFACE = "#fcfcfb";
const TEXT_PRIMARY = "#0b0b0b";
const TEXT_SECONDARY = "#52514e";
const TEXT_MUTED = "#83817c";
const GRID = "#e6e5e1";

const WIDTH = 960;
const HEIGHT = 400;
const FACET_TOP = 116;
const FACET_HEIGHT = 210;
const FACET_GAP = 44;
const MARGIN_LEFT = 56;
const MARGIN_RIGHT = 24;

/**
 * `sd` draws a ±1 s.d. tint around the line. `p90` has none deliberately: it is a QUANTILE, and a
 * standard deviation about a quantile is not a quantity — banding it would put a plausible-looking
 * ribbon around a number it does not describe.
 *
 * `share` gives the two absolute-error panels one y domain so their heights are directly
 * comparable; without it each autoscales and a reader compares two differently-stretched pictures.
 *
 * `fixed` pins bias to ±2 c/kWh. Autoscaling it was actively misleading — bias is flat at zero at
 * every lead, and a domain of ±0.25 rendered pure noise as a strong-looking pattern.
 */
const FACETS: {
  key: keyof Omit<ChartPoint, "lead" | "maeSd" | "biasSd">;
  title: string;
  zeroRule: boolean;
  sd?: keyof Pick<ChartPoint, "maeSd" | "biasSd">;
  share?: "abs";
  fixed?: [number, number];
}[] = [
  {
    key: "mae",
    title: "Mean absolute error",
    zeroRule: false,
    sd: "maeSd",
    share: "abs",
  },
  { key: "p90", title: "p90 absolute error", zeroRule: false, share: "abs" },
  {
    key: "bias",
    title: "Bias (forecast − actual)",
    zeroRule: true,
    sd: "biasSd",
    fixed: [-2, 2],
  },
];

/** Tint opacity for the ±1 s.d. band. Low enough that two overlapping bands stay readable. */
const BAND_OPACITY = 0.16;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function buildSvg(spec: ChartSpec): string {
  const live = spec.series.filter((s) => s.points.length > 0);
  const leads = [
    ...new Set(live.flatMap((s) => s.points.map((p) => p.lead))),
  ].sort((a, b) => a - b);
  if (live.length === 0 || leads.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="120" viewBox="0 0 ${WIDTH} 120">
  <rect width="${WIDTH}" height="120" fill="${SURFACE}"/>
  <text x="24" y="44" font-family="system-ui, sans-serif" font-size="15" fill="${TEXT_PRIMARY}">${esc(spec.title)}</text>
  <text x="24" y="70" font-family="system-ui, sans-serif" font-size="13" fill="${TEXT_SECONDARY}">No scoreable intervals in this window.</text>
</svg>`;
  }

  const facetWidth =
    (WIDTH - MARGIN_LEFT - MARGIN_RIGHT - FACET_GAP * (FACETS.length - 1)) /
    FACETS.length;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="system-ui, -apple-system, sans-serif">`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${SURFACE}"/>`,
    `<text x="24" y="34" font-size="16" font-weight="600" fill="${TEXT_PRIMARY}">${esc(spec.title)}</text>`,
    `<text x="24" y="55" font-size="12.5" fill="${TEXT_SECONDARY}">${esc(spec.subtitle)} · c/kWh incl GST · lead anchored to interval end</text>`,
  );

  // Legend — always present for ≥2 series; identity never colour-alone (points are labelled too).
  if (live.length > 1) {
    let lx = 24;
    for (const [i, s] of live.entries()) {
      const color = SERIES_COLORS[i % SERIES_COLORS.length];
      parts.push(
        `<circle cx="${lx + 5}" cy="${FACET_TOP - 44}" r="5" fill="${color}"/>`,
        `<text x="${lx + 16}" y="${FACET_TOP - 40}" font-size="12.5" fill="${TEXT_SECONDARY}">${esc(s.channel)}</text>`,
      );
      lx += 24 + s.channel.length * 7.2;
    }
  }

  // One domain for every panel marked `share: "abs"`, taken over both panels AND their bands, so a
  // reader can compare the two pictures by height. Anchored at 0 because these are magnitudes.
  const sharedAbs = FACETS.filter((f) => f.share === "abs").flatMap((f) =>
    live.flatMap((s) =>
      s.points.flatMap((p) => [p[f.key], f.sd ? p[f.key] + p[f.sd] : p[f.key]]),
    ),
  );
  const sharedAbsMax = Math.max(...sharedAbs) * 1.08;

  for (const [fi, facet] of FACETS.entries()) {
    const x0 = MARGIN_LEFT + fi * (facetWidth + FACET_GAP);
    const y0 = FACET_TOP;

    let domain: [number, number];
    if (facet.fixed) {
      domain = facet.fixed;
    } else if (facet.share === "abs") {
      domain = [0, sharedAbsMax];
    } else {
      const values = live.flatMap((s) => s.points.map((p) => p[facet.key]));
      let lo = Math.min(...values, facet.zeroRule ? 0 : Infinity);
      let hi = Math.max(...values, facet.zeroRule ? 0 : -Infinity);
      if (lo === hi) {
        lo -= 0.5;
        hi += 0.5;
      }
      const pad = (hi - lo) * 0.12;
      domain = [lo - pad, hi + pad];
    }

    const x = scaleLinear()
      .domain([leads[0], leads[leads.length - 1]])
      .range([x0, x0 + facetWidth]);
    const y = scaleLinear()
      .domain(domain)
      .range([y0 + FACET_HEIGHT, y0]);

    parts.push(
      `<text x="${x0}" y="${y0 - 12}" font-size="12.5" font-weight="600" fill="${TEXT_PRIMARY}">${esc(facet.title)}</text>`,
    );

    // Recessive gridlines + y labels.
    for (const t of y.ticks(4)) {
      parts.push(
        `<line x1="${x0}" y1="${y(t).toFixed(1)}" x2="${(x0 + facetWidth).toFixed(1)}" y2="${y(t).toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`,
        `<text x="${x0 - 8}" y="${(y(t) + 4).toFixed(1)}" font-size="11" text-anchor="end" fill="${TEXT_MUTED}">${t}</text>`,
      );
    }
    if (facet.zeroRule && domain[0] < 0 && domain[1] > 0) {
      parts.push(
        `<line x1="${x0}" y1="${y(0).toFixed(1)}" x2="${(x0 + facetWidth).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="${TEXT_MUTED}" stroke-width="1.5"/>`,
      );
    }
    for (const lead of leads) {
      parts.push(
        `<text x="${x(lead).toFixed(1)}" y="${y0 + FACET_HEIGHT + 18}" font-size="11" text-anchor="middle" fill="${TEXT_MUTED}">${lead}h</text>`,
      );
    }

    const path = d3line<ChartPoint>()
      .x((p) => x(p.lead))
      .y((p) => y(p[facet.key]));

    const sdKey = facet.sd;
    // Clamped to the panel: |error| has a floor of 0 and its distribution is right-skewed, so
    // mae − sd routinely goes negative. Drawing that would assert a negative absolute error.
    const band = sdKey
      ? d3area<ChartPoint>()
          .x((p) => x(p.lead))
          .y0((p) => y(Math.max(domain[0], p[facet.key] - p[sdKey])))
          .y1((p) => y(Math.min(domain[1], p[facet.key] + p[sdKey])))
      : null;

    for (const [i, s] of live.entries()) {
      const color = SERIES_COLORS[i % SERIES_COLORS.length];
      const pts = [...s.points].sort((a, b) => a.lead - b.lead);
      if (band) {
        const b = band(pts);
        if (b) {
          parts.push(
            `<path d="${b}" fill="${color}" fill-opacity="${BAND_OPACITY}" stroke="none"/>`,
          );
        }
      }
      const d = path(pts);
      if (d) {
        parts.push(
          `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
        );
      }
      for (const p of pts) {
        // 2px surface ring so overlapping markers stay countable.
        parts.push(
          `<circle cx="${x(p.lead).toFixed(1)}" cy="${y(p[facet.key]).toFixed(1)}" r="4.5" fill="${color}" stroke="${SURFACE}" stroke-width="2"/>`,
        );
      }
      // Direct label on the last point only — never a number on every point.
      const last = pts[pts.length - 1];
      parts.push(
        `<text x="${(x(last.lead) - 8).toFixed(1)}" y="${(y(last[facet.key]) - 12).toFixed(1)}" font-size="11.5" text-anchor="end" fill="${TEXT_SECONDARY}">${last[facet.key].toFixed(2)}</text>`,
      );
    }
  }

  parts.push(
    `<text x="24" y="${HEIGHT - 12}" font-size="11" fill="${TEXT_MUTED}">Lead time before the interval ends. Higher error at longer lead = the forecast improves as the interval approaches.</text>`,
    `</svg>`,
  );
  return parts.join("\n");
}

/** Write the SVG (always) and a PNG rasterisation (best effort). Returns the files written. */
export async function renderAccuracyChart(
  pngPath: string,
  spec: ChartSpec,
): Promise<string[]> {
  const svg = buildSvg(spec);
  const svgPath = pngPath.replace(/\.png$/i, "") + ".svg";
  mkdirSync(dirname(svgPath), { recursive: true });
  writeFileSync(svgPath, svg);
  const written = [svgPath];

  try {
    const puppeteer = (await import("puppeteer")).default;
    const browser = await puppeteer.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setViewport({
        width: WIDTH,
        height: HEIGHT,
        deviceScaleFactor: 2,
      });
      await page.setContent(
        `<html><body style="margin:0;background:${SURFACE}">${svg}</body></html>`,
        { waitUntil: "load" },
      );
      const el = await page.$("svg");
      if (!el) throw new Error("svg element not found in the rendered page");
      mkdirSync(dirname(pngPath), { recursive: true });
      await el.screenshot({ path: pngPath as `${string}.png` });
      written.push(pngPath);
    } finally {
      await browser.close();
    }
  } catch (e) {
    console.warn(
      `  ⚠ PNG skipped (${e instanceof Error ? e.message : e}) — the SVG is complete.`,
    );
  }

  return written;
}
