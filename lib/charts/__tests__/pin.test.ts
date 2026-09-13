import { describe, expect, it } from "@jest/globals";
import { togglePin } from "../pin";

/** Stands in for a resolved panel payload — a Sankey node's content, or a run band + its anchor. */
const TARGET = { id: "a" };

describe("togglePin", () => {
  describe("nothing pinned yet", () => {
    it("pins what was clicked", () => {
      expect(
        togglePin({
          isSameTarget: false,
          isPinned: false,
          target: TARGET,
          isTouch: false,
        }),
      ).toEqual({ pinned: true, show: TARGET });
    });

    it("pins even when the click lands on what hover is already previewing", () => {
      // The common desktop path: hover opens a preview, then the user clicks to keep it.
      expect(
        togglePin({
          isSameTarget: true,
          isPinned: false,
          target: TARGET,
          isTouch: false,
        }),
      ).toEqual({ pinned: true, show: TARGET });
    });
  });

  describe("something already pinned", () => {
    it("moves the pin to a different target", () => {
      expect(
        togglePin({
          isSameTarget: false,
          isPinned: true,
          target: TARGET,
          isTouch: false,
        }),
      ).toEqual({ pinned: true, show: TARGET });
    });

    it("releases to a hover preview with a mouse", () => {
      // 🛑 Not `show: null`. The pointer is still resting on the thing that was pinned, so blanking
      // would read as the click having closed something for good — and the next mouse movement would
      // pop it back anyway.
      expect(
        togglePin({
          isSameTarget: true,
          isPinned: true,
          target: TARGET,
          isTouch: false,
        }),
      ).toEqual({ pinned: false, show: TARGET });
    });

    it("releases to nothing on touch", () => {
      // There is no pointer at rest to fall back to, so a second tap closes.
      expect(
        togglePin({
          isSameTarget: true,
          isPinned: true,
          target: TARGET,
          isTouch: true,
        }),
      ).toEqual({ pinned: false, show: null });
    });
  });

  it("is a pure tap-toggle on touch, since nothing there is ever previewed", () => {
    // Tap → open, tap again → closed, and back again. The touch path never produces an unpinned
    // open panel, which is why the Sankey and the run bands can share one rule.
    let pinned = false;
    const tap = (isSameTarget: boolean) => {
      const r = togglePin({
        isSameTarget,
        isPinned: pinned,
        target: TARGET,
        isTouch: true,
      });
      pinned = r.pinned;
      return r.show;
    };
    expect(tap(false)).toBe(TARGET);
    expect(tap(true)).toBeNull();
    expect(tap(false)).toBe(TARGET);
  });
});
