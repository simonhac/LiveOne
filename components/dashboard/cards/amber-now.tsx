"use client";

/** The live Amber price pair: the small rate card + the large "now" circle. */
import AmberSmallCard from "@/components/AmberSmallCard";
import AmberNow from "@/components/AmberNow";
import type { CardPlugin, CardRenderProps } from "./types";
import { CardSkeleton, useAreaDatum } from "./shared";
import { CARD_FOOTPRINTS } from "./footprints";

function AreaAmberNow({ handle }: CardRenderProps) {
  const { datum, isLoading } = useAreaDatum(handle!);
  const latest = datum?.latest ?? {};
  // `AmberNow` renders nothing without an import rate, and from inside it cannot tell "no rate yet"
  // from "this area has no Amber tariff" — so the gate lives here, where `isLoading` answers it.
  // Settled-and-absent still collapses (correctly); in-flight now holds the card's space.
  if (isLoading) return <CardSkeleton height={CARD_FOOTPRINTS["amber-now"]} />;
  // ONE root element, not a fragment: the host wraps each card in a `<CardSlot>` to reserve its
  // height, and a fragment's two children would have gone from being separate `gap-4` flex items to
  // being adjacent blocks inside that wrapper. The gap moves here, where it is visible.
  return (
    <div className="flex flex-col gap-4">
      <div className="px-1">
        <AmberSmallCard latest={latest} />
      </div>
      <AmberNow latest={latest} />
    </div>
  );
}

export const amberNowPlugin: CardPlugin = {
  kind: "card",
  type: "amber-now",
  footprint: () => CARD_FOOTPRINTS["amber-now"],
  Render: AreaAmberNow,
};
