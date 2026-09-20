"use client";

import { Zap } from "lucide-react";
import Value from "@/components/ui/value";
import TrendRow from "@/components/ui/trend-row";
import ProgressRing from "@/components/ui/progress-ring";
import TileSurface, { TileHeader } from "@/components/ui/tile-surface";
import { useStaleness } from "@/components/ui/tile-stale";
import { ROLE_CHROME } from "@/lib/role-chrome";
import { TILE_RING, TILE_RING_VALUE, TILE_STALE } from "@/lib/tile-style";
import type { GridLiveValues } from "@/lib/grid/latest";

/** The ring runs green-400 → green-300, the Home Energy renewable ring's hue. */
const RENEWABLES_LIGHT_RGB = "rgb(134, 239, 172)";

export interface GridSignalsCardProps {
  regionLabel: string;
  values: GridLiveValues | null;
  staleThresholdSeconds?: number;
}

/**
 * Presentational "<region> Grid" card (e.g. "NSW Grid"). Shows three live grid signals for the
 * household's local NEM region — spot price ($/MWh), emissions intensity (g CO₂e/kWh) and
 * renewables (%). A small ring tile, the same skeleton as Battery and EV: the renewable share as
 * the ring, price and emissions side by side underneath; narrower than 180px it falls back to the
 * three as label-over-value rows. No data fetching happens here — the typed `values` prop is
 * supplied by the caller.
 *
 * Staleness follows Tile: the newest measurementTime across the present metrics against
 * `staleThresholdSeconds`; stale values dim and the header shows the reading's age.
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

  // Newest measurement time across the present metrics (epoch ms), or null.
  const measurementTimes = [
    values?.price?.measurementTime,
    values?.emissionsIntensity?.measurementTime,
    values?.renewables?.measurementTime,
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

  // Card title, e.g. "NSW Grid". The caller passes the short NEM label ("NSW"); strip a trailing
  // region index defensively so a raw "NSW1" still renders "NSW Grid".
  const regionShort = regionLabel.replace(/\d+$/, "").trim() || regionLabel;

  // Stale values dim and keep their colour, rather than the box dimming — see `TILE_STALE`.
  const tone = (live: string) =>
    `${live} ${staleness.isStale ? TILE_STALE : ""}`;

  const renewablesValue = (
    <Value value={renewablesText} unit={renewables != null ? "%" : undefined} />
  );
  // Price is the grid's magenta (a fact about the grid); emissions stays white.
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
      valueColor={tone("text-ink")}
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
      {/* ≥180px: the ring-tile skeleton — the grid's renewable share as the ring, centred in the
          free height, then price and emissions as one bottom row. Narrower, the ring would leave
          no room for the numbers, so the three become label-over-value rows. */}
      <div className="hidden flex-1 items-center justify-center py-2 @[180px]:flex">
        <ProgressRing
          fraction={(renewables ?? 0) / 100}
          color={ROLE_CHROME.battery.rgb}
          gradientTo={RENEWABLES_LIGHT_RGB}
          className={`${TILE_RING} ${staleness.isStale ? TILE_STALE : ""}`}
        >
          <span className={`${TILE_RING_VALUE} text-ink`}>
            {renewablesValue}
          </span>
          <span className="mt-1 text-[11px] font-medium leading-none text-tile-ink-muted">
            renewable
          </span>
        </ProgressRing>
      </div>
      <div className="hidden justify-between gap-2 @[180px]:flex">
        {priceRow}
        {emissionsRow}
      </div>
      <div className="mt-2 grid grid-cols-1 gap-y-2 @[180px]:hidden">
        {priceRow}
        {emissionsRow}
        <TrendRow
          label="Renewables"
          value={renewablesValue}
          valueColor={tone(
            renewablesGreen ? ROLE_CHROME.battery.value : "text-ink",
          )}
        />
      </div>
    </TileSurface>
  );
}
