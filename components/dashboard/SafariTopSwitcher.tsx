"use client";

import {
  SAFARI_TOP_VARIANTS,
  type SafariTopVariant,
} from "@/lib/dashboard/useSafariTopVariant";
import {
  SEGMENTED_ITEM,
  SEGMENTED_ITEM_OFF,
  SEGMENTED_ITEM_ON,
  SEGMENTED_TRACK,
} from "@/components/ui/segmented";

/**
 * 🚧 TEMPORARY — delete this file, `lib/dashboard/useSafariTopVariant.ts`, the `[data-safari-top]`
 * rules in `globals.css` and the block in `DashboardClient` once the Safari top-band variant is
 * chosen. See the hook for what each variant does.
 *
 * Sits at the END of the page content deliberately: the thing under test is the top edge, and a
 * floating control near it could confound the very band being judged.
 */
export default function SafariTopSwitcher({
  variant,
  onChange,
}: {
  variant: SafariTopVariant;
  onChange: (next: SafariTopVariant) => void;
}) {
  return (
    <div className="flex items-center justify-center gap-2 px-4 py-6">
      <span className="text-xs text-gray-500">safari top</span>
      <div className={SEGMENTED_TRACK} role="group">
        {SAFARI_TOP_VARIANTS.map((v) => (
          <button
            key={v}
            onClick={() => onChange(v)}
            aria-pressed={variant === v}
            className={`${SEGMENTED_ITEM} ${
              variant === v ? SEGMENTED_ITEM_ON : SEGMENTED_ITEM_OFF
            }`}
          >
            {v}
          </button>
        ))}
      </div>
    </div>
  );
}
