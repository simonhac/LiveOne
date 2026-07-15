"use client";

/** The live Amber price pair: the small rate card + the large "now" circle. */
import AmberSmallCard from "@/components/AmberSmallCard";
import AmberNow from "@/components/AmberNow";
import type { CardPlugin, CardRenderProps } from "./types";
import { useAreaDatum } from "./shared";

function AreaAmberNow({ handle }: CardRenderProps) {
  const { datum } = useAreaDatum(handle!);
  const latest = datum?.latest ?? {};
  return (
    <>
      <div className="px-1">
        <AmberSmallCard latest={latest} />
      </div>
      <AmberNow latest={latest} />
    </>
  );
}

export const amberNowPlugin: CardPlugin = {
  type: "amber-now",
  Render: AreaAmberNow,
};
