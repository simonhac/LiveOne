/**
 * The gallery's sections, as data — the one list both the page and `e2e/cards.spec.ts` read.
 *
 * The spec walks these to census every card in every state, so a section that is not here is a
 * section the colour census cannot see. Deriving the page's scenario pickers from the same array is
 * what makes that true by construction rather than by a reminder: a `<CardSection>` whose `slug` is
 * not in this list will not compile, and one listed here that the page never renders fails the
 * "census covers every section the gallery renders" case in `e2e/cards.spec.ts`.
 *
 * Mirrors `app/labs/chart-gallery/cases` and the `charts.spec.ts` guard that reads it.
 */
import {
  SOLAR_SCENARIOS,
  LOAD_SCENARIOS,
  GENERATOR_SCENARIOS,
  GENERATOR_CONTROL_SCENARIOS,
  BATTERY_SCENARIOS,
  GRID_SCENARIOS,
  AMBER_SCENARIOS,
  TESLA_SCENARIOS,
  HWS_SCENARIOS,
  GRID_SIGNALS_SCENARIOS,
  BATTERY_CONTENTS_SCENARIOS,
  HOME_ENERGY_SCENARIOS,
  EV_PROVENANCE_SCENARIOS,
} from "./fixtures";

export interface GallerySection {
  /** URL-safe id: `?section=<slug>` renders this one alone. */
  slug: string;
  /** Every state the picker offers, in order; the first is the default. */
  scenarios: string[];
}

export const SECTIONS = [
  { slug: "power-solar", scenarios: Object.keys(SOLAR_SCENARIOS) },
  { slug: "power-load", scenarios: Object.keys(LOAD_SCENARIOS) },
  { slug: "power-battery", scenarios: Object.keys(BATTERY_SCENARIOS) },
  { slug: "power-grid", scenarios: Object.keys(GRID_SCENARIOS) },
  { slug: "generator", scenarios: Object.keys(GENERATOR_SCENARIOS) },
  {
    slug: "generator-controls",
    scenarios: Object.keys(GENERATOR_CONTROL_SCENARIOS),
  },
  { slug: "hot-water", scenarios: Object.keys(HWS_SCENARIOS) },
  { slug: "amber-small", scenarios: Object.keys(AMBER_SCENARIOS) },
  { slug: "tesla-small", scenarios: Object.keys(TESLA_SCENARIOS) },
  { slug: "grid-signals", scenarios: Object.keys(GRID_SIGNALS_SCENARIOS) },
  { slug: "amber-now", scenarios: Object.keys(AMBER_SCENARIOS) },
  {
    slug: "battery-contents",
    scenarios: Object.keys(BATTERY_CONTENTS_SCENARIOS),
  },
  { slug: "home-energy", scenarios: Object.keys(HOME_ENERGY_SCENARIOS) },
  { slug: "ev-provenance", scenarios: Object.keys(EV_PROVENANCE_SCENARIOS) },
] as const satisfies readonly GallerySection[];

export type SectionSlug = (typeof SECTIONS)[number]["slug"];

/** Scenarios for one slug — the page's picker and the spec's walk read the same array. */
export function scenariosOf(slug: SectionSlug): string[] {
  const s = SECTIONS.find((x) => x.slug === slug);
  if (!s) throw new Error(`unknown gallery section: ${slug}`);
  return [...s.scenarios];
}
