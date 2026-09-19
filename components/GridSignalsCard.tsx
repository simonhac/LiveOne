"use client";

import { Zap } from "lucide-react";
import Value from "@/components/ui/value";
import TrendRow from "@/components/ui/trend-row";
import ProgressRing from "@/components/ui/progress-ring";
import TileSurface, { TileHeader } from "@/components/ui/tile-surface";
import { useStaleness } from "@/components/ui/tile-stale";
import { ROLE_CHROME } from "@/lib/role-chrome";
import { TILE_STALE } from "@/lib/tile-style";
import type { GridLiveValues } from "@/lib/grid/latest";

/** The ring runs green-400 → green-300, the Home Energy renewable ring's hue. */
const RENEWABLES_LIGHT_RGB = "rgb(134, 239, 172)";

export interface GridSignalsCardProps {
  regionLabel: string;
  values: GridLiveValues | null;
  staleThresholdSeconds?: number;
}

/**
 * Presentational "<region> Grid" card (e.g. "NSW Grid"). Shows four live grid signals for the
 * household's local NEM region — spot price ($/MWh), emissions intensity (g CO₂e/kWh), renewables
 * (%) and operational demand (MW). A MEDIUM tile (`span: 2`): the renewable share as a ring beside
 * the other three as Trends rows; narrower than 300px it falls back to a label-over-value 2×2. No data fetching happens here — the typed `values`
 * prop is supplied by the caller.
 *
 * Staleness follows Tile: the newest measurementTime across the present metrics against
 * `staleThresholdSeconds`; stale values grey out and the header shows the reading's age.
 */
export default function GridSignalsCard({
  regionLabel,
  values,
  // OpenElectricity is 5-min-native and measurementTime is the interval END, so the freshest
  // reading is routinely 5+ min old just before the next interval publishes (plus poll/relay lag).
  // 900s keeps the card "fresh" across a normal cycle and a single missed interval.
  staleThresholdSeconds = 900,
}: GridSignalsCardProps) {
  const price = values?.price?.value ?? null;
  const emissions = values?.emissionsIntensity?.value ?? null;
  const renewables = values?.renewables?.value ?? null;
  const demand = values?.demand?.value ?? null;

  // Newest measurement time across the present metrics (epoch ms), or null.
  const measurementTimes = [
    values?.price?.measurementTime,
    values?.emissionsIntensity?.measurementTime,
    values?.renewables?.measurementTime,
    values?.demand?.measurementTime,
  ]
    .filter((t): t is string => typeof t === "string")
    .map((t) => new Date(t).getTime())
    .filter((ms) => !Number.isNaN(ms));
  const newestMs = measurementTimes.length
    ? Math.max(...measurementTimes)
    : null;
  const staleness = useStaleness(newestMs, staleThresholdSeconds);

  // Defensive: nothing to show at all.
  if (!regionLabel && values === null) {
    return null;
  }

  // Display values (client-side conversions per the OE stored units). Units render separately, so
  // these are the bare numbers only.
  // Price is stored in $/MWh; show it directly as integer dollars ("$84/MWh"). The "$" rides as a
  // `prefix` so it renders at unit size, not hero size.
  const priceText = price != null ? `${Math.round(price)}` : "—";
  // 0 g/kWh is physically impossible for a generating grid (a transient OE artifact); show
  // an em-dash rather than a bogus "0" until the next good reading lands.
  const emissionsText =
    emissions != null && emissions > 0
      ? `${Math.round(emissions * 1000)}`
      : "—";
  const renewablesText = renewables != null ? `${Math.round(renewables)}` : "—";
  const renewablesGreen = renewables != null && renewables > 50;
  // Operational demand is stored in MW; show integer MW with a thousands separator ("7,234").
  const demandText =
    demand != null ? Math.round(demand).toLocaleString("en-AU") : "—";

  // Card title, e.g. "NSW Grid". The caller passes the short NEM label ("NSW"); strip a trailing
  // region index defensively so a raw "NSW1" still renders "NSW Grid".
  const regionShort = regionLabel.replace(/\d+$/, "").trim() || regionLabel;

  // Stale values dim and keep their colour, rather than the box dimming — see `TILE_STALE`.
  const tone = (live: string) =>
    `${live} ${staleness.isStale ? TILE_STALE : ""}`;

  const renewablesValue = (
    <Value value={renewablesText} unit={renewables != null ? "%" : undefined} />
  );
  // Price and demand are the grid's magenta (they are facts about the grid); emissions stays white.
  const priceRow = (
    <TrendRow
      label="Price"
      value={
        <Value
          value={priceText}
          prefix={price != null ? "$" : undefined}
          unit={price != null ? "/MWh" : undefined}
        />
      }
      valueColor={tone(ROLE_CHROME.grid.value)}
    />
  );
  const emissionsRow = (
    <TrendRow
      label="Emissions"
      value={
        <Value
          value={emissionsText}
          unit={emissionsText !== "—" ? "g/kWh" : undefined}
        />
      }
      valueColor={tone("text-white")}
    />
  );
  const demandRow = (
    <TrendRow
      label="Demand"
      value={
        <Value value={demandText} unit={demand != null ? "MW" : undefined} />
      }
      valueColor={tone(ROLE_CHROME.grid.value)}
    />
  );

  return (
    <TileSurface surfaceClassName="flex flex-col">
      <TileHeader
        title={`${regionShort} Grid`}
        icon={<Zap />}
        tone={ROLE_CHROME.grid.value}
        staleness={staleness}
        measurementTime={newestMs}
      />
      {/* MEDIUM (the width a two-column tile has): the Activity Rings shape — the grid's
          renewable share as a ring on the left, the other three signals as Trends rows on the
          right, so the card fills its height the way Home Energy beside it does instead of one line
          of numbers over an empty box. SMALL: the four as a label-over-value 2×2 (1 column when
          very narrow). The renewables number sits inside the ring in the medium form, so it is a
          row only in the small one. */}
      <div className="mt-2 hidden flex-1 items-center gap-5 @[300px]:flex">
        <ProgressRing
          fraction={(renewables ?? 0) / 100}
          color={ROLE_CHROME.battery.rgb}
          gradientTo={RENEWABLES_LIGHT_RGB}
          className={`h-[112px] w-[112px] shrink-0 @[440px]:h-[128px] @[440px]:w-[128px] ${
            staleness.isStale ? TILE_STALE : ""
          }`}
        >
          <span className="text-[24px] font-bold leading-none text-white">
            {renewablesValue}
          </span>
          <span className="mt-1 text-[11px] font-medium leading-none text-white/55">
            renewable
          </span>
        </ProgressRing>
        <div className="min-w-0 flex-1 space-y-2">
          {priceRow}
          {emissionsRow}
          {demandRow}
        </div>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-2 @[200px]:grid-cols-2 @[300px]:hidden">
        {priceRow}
        {emissionsRow}
        <TrendRow
          label="Renewables"
          value={renewablesValue}
          valueColor={tone(
            renewablesGreen ? ROLE_CHROME.battery.value : "text-white",
          )}
        />
        {demandRow}
      </div>
    </TileSurface>
  );
}
