/**
 * Class tokens for the segmented pill — one track holding N mutually-exclusive segments, in the
 * style of Apple Health's D|W|M|Y control: a translucent rounded-full rail, the selected segment a
 * solid lozenge, the rest bare text.
 *
 * Tokens rather than a component because the three users differ structurally — {@link PeriodSwitcher}
 * maps over a list, the prev/next groups are two fixed icon buttons with a `disabled` state — while
 * needing to read as ONE control when they sit side by side in a navigator row.
 *
 * No borders and no `-ml-px` seam: segments are separated by the track showing through, so none of
 * the border/z-index collapsing the old bordered group needed applies here.
 */

/** The rail. Add `gap-*` only if you want the segments further apart than the padding implies. */
export const SEGMENTED_TRACK = "inline-flex rounded-full bg-rail p-0.5";

/** Every segment, selected or not. */
export const SEGMENTED_ITEM =
  "rounded-full px-3 py-1 text-xs font-semibold transition-colors";

/** Icon segments (chevrons) — squarer padding so the glyph sits centred in a round lozenge. */
export const SEGMENTED_ICON_ITEM =
  "rounded-full px-2 py-1 transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

export const SEGMENTED_ITEM_ON = "bg-surface-control-hover text-ink shadow-sm";

export const SEGMENTED_ITEM_OFF = "text-ink-secondary hover:text-ink";
