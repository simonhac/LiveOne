import type React from "react";

/**
 * The free height of a ring tile, with its ring centred in it and sized to fill it.
 *
 * A SIZE container (`container-type: size`), which is what lets the ring read the box it has been
 * given (`--ring` = the smaller of its width and height) — and also why it cannot make a tile
 * taller: size containment drops its content from the intrinsic size, so all it ever asks the row
 * for is its `min-h`: the ring's floor (76px, 108px from 180px of tile width) plus its padding. The
 * ring then grows only into height the `auto-rows-fr` row was already handing out.
 *
 * 🛑 `100cqh` is 0, not the min-height, when the tile's height is its CONTENT (a lone tile, the card
 * gallery's presets): the well's height is then only ever its min-h, which Chrome does not count as
 * the container's size. Hence the explicit floor inside `--ring` — without it every such ring
 * rendered 0×0. In the dashboard's `auto-rows-fr` grid the height is definite and `100cqh` is real.
 *
 * Its own `@[…]` variants still measure the tile (a container query never matches the element that
 * declares the container); anything INSIDE it would measure the well, so ring contents size off
 * `--ring` instead — see `TILE_RING` in lib/tile-style.ts.
 */
export default function RingWell({ children }: { children: React.ReactNode }) {
  return (
    // min-h = the fixed ring + this py-2 (border-box), so the floor is exactly the old wrapper's.
    <div className="grid min-h-[92px] flex-1 place-items-center py-2 [container-type:size] [--ring-floor:76px] [--ring:min(100cqw,max(var(--ring-floor),100cqh))] @[180px]:min-h-[124px] @[180px]:[--ring-floor:108px]">
      {children}
    </div>
  );
}
