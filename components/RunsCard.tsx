"use client";

import { useQuery } from "@tanstack/react-query";
import { runPeriodsQuery } from "@/lib/queries";
import { useTemporalRange } from "@/lib/charts/useTemporalRange";
import { getPeriodDuration, toInstantRange } from "@/lib/charts/temporal";
import { formatSecondsAsDuration } from "@/lib/fe-date-format";
import { formatRunWhenLines } from "@/lib/run-tracking/run-period-view";
import { formatDollars, formatKgCo2 } from "@/lib/provenance-format";
import {
  CHART_BODY_PAD,
  LEGEND_HEADER,
  LEGEND_LABEL,
  LEGEND_VALUE,
  TABLE_GUTTER,
} from "@/lib/charts/style";

/**
 * A dashboard panel listing one tracked device's run periods WITHIN the temporal-navigator window —
 * the same D/W/M/Y + prev/next window the charts respect (read via {@link useTemporalRange}). A run
 * that overlaps the window is shown in full.
 *
 * ROLE-GENERIC. `role` selects which detector's periods to list (`generator` runs, `ev` charge
 * sessions); the copy comes in as props because only the caller knows which noun is right. The data
 * path never needed generalising — `/api/device/{id}/run-periods` has always taken `?role=`, and the
 * columns it advertises are planned from the ROWS (units, provenance), not from the role, so an EV
 * session and a generator run render through exactly the same table.
 *
 * The footer totals (count, run-time, kWh) sum the FULL value of every overlapping run — a run that
 * extends before/after the window is counted whole (its energy isn't uniform, so it can't be
 * meaningfully clipped). Such a run is marked with an asterisk and a footnote appears under the
 * table explaining it (only when at least one run is marked).
 *
 * Shown on dashboards whose member device has an enabled run detector (see the `runs` entry in
 * lib/capabilities/catalog.ts). In live mode (D/W) it requests period mode (`1d`/`7d`, stable query
 * key); in historical mode (and always for M/Y) it requests the explicit `start`/`end` range.
 *
 * `runningOverride` carries the live on/off state from the generic latest map (the derived
 * `<role stem>/running` point) so the badge comes from /api/data like every other live value; it
 * falls back to the run-periods response's open-period flag when that point isn't present.
 */
export default function RunsCard({
  systemId,
  timezoneOffsetMin,
  role = "generator",
  title = "Generator runs",
  emptyText = "No generator runs in this period",
  untrackedText = "No generator run detector for this device",
  activeLabel = "running",
  noun = "run",
  runningOverride,
}: {
  systemId: number;
  timezoneOffsetMin: number;
  /** Which detector's periods to list. Defaults to the generator, this card's only role until EV. */
  role?: string;
  title?: string;
  emptyText?: string;
  /**
   * Shown INSTEAD of `emptyText` when the server reports no detector for this `(subject, role)`.
   *
   * 🛑 These are two different facts and must not share a message. "No charge sessions in this period"
   * is a claim about the period; "nothing here is tracked" is a claim about the configuration, and
   * rendering the first for the second is how this card once reported no sessions on a page whose
   * chart was bracketing them. Same principle as `energyKwh` being null rather than 0 on the wire.
   */
  untrackedText?: string;
  /** Badge text while a period is open, e.g. "running" / "charging". */
  activeLabel?: string;
  /** Footer count noun, singular; pluralised with a bare "s" ("run"/"runs", "session"/"sessions"). */
  noun?: string;
  runningOverride?: boolean;
}) {
  const { period, start, end, isHistoricalMode } = useTemporalRange({
    timezoneOffsetMin,
  });

  // 🛑 Through `toInstantRange`, never raw. For M/Y the navigator's `start`/`end` are tz-naive
  // UTC-midnight markers naming LOCAL calendar days (the `1d` history encoder's convention), and this
  // endpoint filters on real timestamps — so passing them through shifted the whole window by the
  // offset and truncated the inclusive last day at 00:00 UTC, dropping late runs on it. D/W are
  // already instants and pass through unchanged.
  const window = toInstantRange({ period, start, end }, timezoneOffsetMin);

  const { data, isPending, isError } = useQuery(
    runPeriodsQuery(
      isHistoricalMode && window
        ? { systemId, role, start: window.start, end: window.end }
        : {
            systemId,
            role,
            // Live D/W → the run-periods API expects an `Nd` string (`parseInt(period.replace("d",""))`).
            // D→"1d", W→"7d" (M/Y always take the explicit start/end branch above, so never reach here).
            period: `${Math.round(getPeriodDuration(period) / 86_400_000)}d`,
          },
    ),
  );

  // The strict window the navigator is showing, used only to flag runs that extend beyond it.
  const nowMs = Date.now();
  // Same instants that were REQUESTED — not the raw params — so a run is marked as spanning outside
  // the window against the window the server actually filtered on.
  const windowEndMs =
    isHistoricalMode && window ? Date.parse(window.end) : nowMs;
  const windowStartMs =
    isHistoricalMode && window
      ? Date.parse(window.start)
      : nowMs - getPeriodDuration(period);

  // Server returns events oldest-first; show newest-first in the panel. Decorate each with its
  // duration/energy and whether it spans outside the window, and accumulate the (full-value) totals.
  const rows = (data?.events ? [...data.events].reverse() : []).map((e) => {
    const startMs = e.startTimeISO ? Date.parse(e.startTimeISO) : NaN;
    const endMs = e.running
      ? nowMs
      : e.endTimeISO
        ? Date.parse(e.endTimeISO)
        : nowMs;
    const durationSec = e.running
      ? (nowMs - startMs) / 1000
      : (e.durationSeconds ?? null);
    const spansOutside =
      (Number.isFinite(startMs) && startMs < windowStartMs) ||
      endMs > windowEndMs;
    return { e, durationSec, spansOutside };
  });

  const totalSeconds = rows.reduce((s, r) => s + (r.durationSec ?? 0), 0);
  // Known energy only, and null when NOTHING was known — the footer then shows "—" rather than a
  // total that silently counts unmeasured runs as zero.
  const totalEnergyKwh = rows.reduce<number | null>(
    (s, r) => (r.e.energyKwh == null ? s : (s ?? 0) + r.e.energyKwh),
    null,
  );
  const anyOutside = rows.some((r) => r.spansOutside);

  // The two provenance columns, each gated SERVER-side on what the returned rows actually carry
  // (`resolveShape` in the run-periods route) rather than on the site's config — so a column is
  // absent rather than a wall of "—", and never $0.00 for an unpriced run.
  //
  // Merging Date+Time into one "when" column bought one slot back; cost took it and CO₂ makes this
  // genuinely wider than the original four. That is affordable because the numbers are short and
  // `when` is the only wrappable cell, but it is the reason each column stays gated: a device with
  // no energy point still renders the narrow three-column table.
  // 🛑 Energy is GATED, and used not to be. A detector with no energy point (the Sigenergy EV
  // charger publishes power only) has NULL energy on every row, which the wire coalesces to 0 — so
  // an ungated column printed "0.0 kWh" against every charge session. When it is absent, fall back
  // to the average POWER the plan already computes from the signal (`avgPowerBasis: "signal"`),
  // which is the figure GeneratorClient has always shown for exactly this case. Deliberately only
  // as a fallback: a device WITH energy keeps its existing three-column table rather than gaining a
  // fourth in a card whose width is the reason every column here is gated.
  const showEnergy = data?.columns?.energy ?? false;
  const showAvgPower = !showEnergy && (data?.columns?.avgPower ?? false);
  const showCost = data?.columns?.cost ?? false;
  const showEmissions = data?.columns?.emissions ?? false;
  // Totals sum only the runs that carry a figure, matching how the footer's other totals behave.
  const totalCostC = rows.reduce<number | null>(
    (s, r) => (r.e.costC == null ? s : (s ?? 0) + r.e.costC),
    null,
  );
  const totalEmissionsG = rows.reduce<number | null>(
    (s, r) => (r.e.emissionsG == null ? s : (s ?? 0) + r.e.emissionsG),
    null,
  );

  // `align-top`: a header with a stacked unit is two lines, and every label — stacked or not — sits
  // on the first, so the header row reads as one line of words with the units hanging below.
  //
  // Cell padding is 8px a side until the CARD (not the viewport — see `@container` below) has room
  // for 16: five columns at 32px of padding each is ~160px of a ~330px phone-width card. The outer
  // edges take NONE: the card's own `CHART_BODY_PAD` + `TABLE_GUTTER` already hold the table off
  // the screen edge, by exactly the amount they hold the stacked charts' energy table off it, and
  // a first column indented further than that one reads as a different kind of object.
  const cellPad =
    "px-2 first:pl-0 last:pr-0 @[480px]:px-4 @[480px]:first:pl-0 @[480px]:last:pr-0";
  // Read like a chart legend, not a spreadsheet: the tokens are the legend's own
  // (`lib/charts/style.ts`), so a card holding a chart and a table speaks with one voice. No fill
  // behind the header, no zebra, no row rules — the numbers' alignment is what makes the columns.
  // 🛑 The rules live on the CELLS, not on the `<tr>`. Tailwind's preflight collapses table borders,
  // and a collapsed border belongs to the table rather than to the row — so a border on a sticky
  // `<tr>` scrolls away with the body instead of sticking with its header.
  const th = `${cellPad} py-2 align-top text-xs font-normal border-b border-line ${LEGEND_HEADER}`;
  const td = `${cellPad} py-2 text-sm`;
  /** A numeric cell. `LEGEND_VALUE` brings the mono face, tabular figures and right alignment. */
  const tdNum = `${td} ${LEGEND_VALUE}`;
  /** The Duration cell. `whitespace-nowrap` because "5h30m" is ONE quantity and must not break
   *  across two lines in a narrow column. 🛑 Not on the "When" column — see the note on its `<td>`
   *  for why a nowrap there pushes the rightmost column out of the card. */
  const tdDuration = `${tdNum} whitespace-nowrap`;
  /** A header's unit, muted so the scanned word is the quantity ("Energy") and not its unit, and
   *  STACKED under the label rather than beside it: a numeric column is only as wide as its widest
   *  cell, and "Energy kWh" on one line made the header, not the numbers, the widest cell — enough,
   *  across Energy/Avg/CO₂, to push Cost out of a phone-width card. */
  const unit = (u: string) => (
    <span className="block font-normal text-ink-faint">{u}</span>
  );

  // No box. This table sits under a stacked chart whose own `EnergyTable` is frameless and inset by
  // `CHART_BODY_PAD` + `TABLE_GUTTER`; two tables reading the same window should start at the same
  // pixel and carry the same ink, so this one borrows both and leans on its sticky header/footer
  // rules for the edges a scroll region needs. See docs/architecture/chart-style.md rule 3.
  return (
    <div className={CHART_BODY_PAD}>
      <div className={`${TABLE_GUTTER} @container`}>
        <div className="flex items-center justify-between pb-2 border-b border-line-soft">
          <h2 className="text-sm font-semibold text-ink-strong flex items-center gap-2">
            {title}
            {(runningOverride ?? data?.running) && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-ok">
                <span className="w-1.5 h-1.5 rounded-full bg-ok animate-pulse" />
                {activeLabel}
              </span>
            )}
          </h2>
        </div>

        {isPending && !data ? (
          // Sized to the empty/short settled body rather than a line of text, so the common case —
          // "nothing in this period" — is a swap rather than a resize. A long run list still grows
          // past this — a known residual (see dashboard-layout-stability.md).
          <div className="py-6" data-skeleton="" aria-hidden>
            <div className="h-5 w-2/3 animate-pulse rounded bg-skeleton-quiet" />
          </div>
        ) : isError ? (
          <div className="py-6 text-sm text-danger">
            Failed to load {title.toLowerCase()}
          </div>
        ) : data?.tracked === false ? (
          // Not "nothing happened" — nothing is watching. `tracked` is optional on the wire, so an
          // older deployment's response (undefined) keeps the period reading, which is what every
          // caller assumed before the field existed.
          <div className="py-6 text-sm text-ink-muted">{untrackedText}</div>
        ) : rows.length === 0 ? (
          <div className="py-6 text-sm text-ink-muted">{emptyText}</div>
        ) : (
          <>
            <div className="max-h-[420px] overflow-y-auto">
              <table className="w-full">
                {/* 🛑 `bg-canvas`, and not a translucent tint: a sticky header has rows scrolling
                  UNDER it, so it needs an opaque backing or the text collides. Black is the
                  dashboard canvas, so the opacity is invisible. */}
                <thead className="sticky top-0 bg-canvas">
                  <tr>
                    <th className={`${th} text-left`}>When</th>
                    <th className={`${th} text-right`}>Duration</th>
                    {showEnergy && (
                      <th className={`${th} text-right`}>
                        Energy{unit("kWh")}
                      </th>
                    )}
                    {showAvgPower && (
                      <th className={`${th} text-right`}>Avg{unit("kW")}</th>
                    )}
                    {showEmissions && (
                      <th className={`${th} text-right`}>CO₂{unit("kg")}</th>
                    )}
                    {showCost && <th className={`${th} text-right`}>Cost</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ e, durationSec, spansOutside }, i) => (
                    <tr key={i}>
                      {/* Deliberately NOT whitespace-nowrap: this card sits in a fixed-width
                        dashboard column, and a midnight-crossing run's full
                        "Mon 27 Jul, 23:40 – Tue 28 Jul, 01:15" would set a min-content width that
                        pushes the rightmost column out of the card's `overflow-hidden` box. */}
                      <td className={td}>
                        <RunWhenCell e={e} spansOutside={spansOutside} />
                      </td>
                      <td className={tdDuration}>
                        {durationSec != null
                          ? formatSecondsAsDuration(durationSec)
                          : "—"}
                      </td>
                      {showEnergy && (
                        <td className={tdNum}>
                          {e.energyKwh != null ? e.energyKwh.toFixed(1) : "—"}
                        </td>
                      )}
                      {showAvgPower && (
                        <td className={tdNum}>
                          {e.avgPowerW != null
                            ? (e.avgPowerW / 1000).toFixed(1)
                            : "—"}
                        </td>
                      )}
                      {showEmissions && (
                        <td className={tdNum}>
                          {e.emissionsG != null
                            ? formatKgCo2(e.emissionsG / 1000)
                            : "—"}
                        </td>
                      )}
                      {showCost && (
                        <td className={tdNum}>
                          {e.costC != null ? formatDollars(e.costC) : "—"}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
                <tfoot className="sticky bottom-0 bg-canvas [&_td]:border-t [&_td]:border-line">
                  <tr className="font-medium">
                    <td className={`${td} ${LEGEND_LABEL}`}>
                      {rows.length} {rows.length === 1 ? noun : `${noun}s`}
                    </td>
                    <td className={tdDuration}>
                      {formatSecondsAsDuration(totalSeconds)}
                    </td>
                    {showEnergy && (
                      <td className={tdNum}>
                        {totalEnergyKwh != null
                          ? totalEnergyKwh.toFixed(1)
                          : "—"}
                      </td>
                    )}
                    {/* No total for average power: a mean of means is not the window's average, and
                      an energy-weighted one needs the energy this card does not have. */}
                    {showAvgPower && <td className={td} />}
                    {showEmissions && (
                      <td className={tdNum}>
                        {totalEmissionsG != null
                          ? formatKgCo2(totalEmissionsG / 1000)
                          : "—"}
                      </td>
                    )}
                    {showCost && (
                      <td className={tdNum}>
                        {totalCostC != null ? formatDollars(totalCostC) : "—"}
                      </td>
                    )}
                  </tr>
                </tfoot>
              </table>
            </div>
            {anyOutside && (
              <div className="py-2 text-xs text-ink-muted border-t border-line">
                <span className="text-warn font-semibold">*</span> Run extends
                beyond the selected period; its full duration and energy are
                included in the totals.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The date half of a run's "when": a touch heavier, since it is what the eye scans the column by.
 * `text-ink-secondary` is the legend's label tone (`LEGEND_LABEL`) — in a legend-styled table the NUMBERS
 * are the bright thing, and a full-strength label column competes with them.
 */
const WHEN_DATE = "font-medium text-ink-secondary";
/** The time half: a touch dimmer, subordinate to the date it belongs to. */
const WHEN_TIME = "text-ink-muted";

/**
 * "10:05am–3:09pm" that stays on one line when it fits and, when a row's numbers are wide enough
 * that it cannot, breaks AFTER the dash — never inside a time ("10:0" / "5am"). Each time is
 * `nowrap`; the only break opportunity is the `<wbr>`.
 */
function TimeRange({ text }: { text: string }) {
  const dash = text.indexOf("–");
  if (dash === -1) return <span className="whitespace-nowrap">{text}</span>;
  return (
    <>
      <span className="whitespace-nowrap">{text.slice(0, dash + 1)}</span>
      <wbr />
      <span className="whitespace-nowrap">{text.slice(dash + 1)}</span>
    </>
  );
}

/**
 * A run's "when" cell. A run inside ONE day is the date, then its time range — on one line when the
 * card has room, else on the next line; the range breaks only after its dash, never inside a time. A midnight-crossing run keeps each date with its own time and
 * wraps as prose; there is no clean two-line split for it (see `formatRunWhenLines`).
 */
function RunWhenCell({
  e,
  spansOutside,
}: {
  e: Parameters<typeof formatRunWhenLines>[0];
  spansOutside: boolean;
}) {
  const marker = spansOutside && (
    <sup className="font-semibold text-warn">*</sup>
  );
  const lines = formatRunWhenLines(e);
  if (lines.length === 2) {
    return (
      <>
        {/* Stacked only while the card is narrow; from 480px there is room for one line. */}
        <span className={`block @[480px]:inline ${WHEN_DATE}`}>{lines[0]}</span>
        <span
          // A size down while stacked, which is what lets the range stay on one line at phone width.
          className={`block text-[13px] @[480px]:ml-1.5 @[480px]:inline @[480px]:text-sm ${WHEN_TIME}`}
        >
          <TimeRange text={lines[1]} />
          {marker}
        </span>
      </>
    );
  }
  // Midnight-crossing: "Mon 27 Jul, 11:40pm – Tue 28 Jul, 1:15am", the same words as
  // `formatRunWhenLines`, with each part in its own weight.
  return (
    <>
      <span className={WHEN_DATE}>{e.date}</span>
      <span className={WHEN_TIME}>, {e.startTime} – </span>
      <span className={WHEN_DATE}>{e.endDate}</span>
      <span className={WHEN_TIME}>, {e.endTime}</span>
      {marker}
    </>
  );
}
