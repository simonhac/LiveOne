"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * "Is there a chart on this page a finger can step the window with, right now?"
 *
 * 🛑 The reason this exists rather than a bare media query. On touch, {@link TemporalNavigator}
 * hides its prev/next pill because the chart's axis strip does that job instead
 * (`DashboardChart`'s axis-tap zones). But the navigator is shown for EVERY time-traveling card —
 * runs tables, hot water, renewables — and those have no axis to tap. Hiding the buttons
 * unconditionally therefore left a phone with no way at all to reach yesterday on a dashboard whose
 * cards happen not to include a chart. The same hole opens transiently on any dashboard: while the
 * history is loading, or has failed, or came back empty, `DashboardChart` is not on screen and its
 * zones do not exist.
 *
 * So the charts DECLARE the capability while they are actually drawing it, and the navigator hides
 * its buttons only against a live declaration. Both halves fail SHOWN: no provider, no chart, or a
 * chart that is not offering taps all leave the buttons where they are.
 *
 * Page-wide, mounted beside {@link ChartFocusProvider} — the navigator in the header and the charts
 * down the page are not in the same card, and the question is about the page.
 */
interface AxisNav {
  /** At least one mounted chart is currently offering axis-tap stepping. */
  available: boolean;
  /** Declare one. Returns the matching release; see {@link useProvideAxisNav}. */
  retain: () => () => void;
}

// Default: nothing declared and nothing can be. Outside a provider the navigator keeps its buttons,
// which is the safe direction — an extra control, never a missing one.
const AxisNavContext = createContext<AxisNav>({
  available: false,
  retain: () => () => {},
});

export function AxisNavProvider({ children }: { children: ReactNode }) {
  // A COUNT, not a boolean: a dashboard has several charts (load + generation + lines), they mount
  // and unmount independently, and React may mount the next one before unmounting the last. A
  // boolean flips to false on the first release and strands the navigator without its buttons.
  const countRef = useRef(0);
  const [available, setAvailable] = useState(false);

  const retain = useCallback(() => {
    countRef.current += 1;
    setAvailable(true);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      countRef.current -= 1;
      if (countRef.current <= 0) setAvailable(false);
    };
  }, []);

  const value = useMemo(() => ({ available, retain }), [available, retain]);
  return (
    <AxisNavContext.Provider value={value}>{children}</AxisNavContext.Provider>
  );
}

/**
 * Declare, for as long as `active` holds, that this chart is offering axis-tap stepping.
 *
 * Call it UNCONDITIONALLY (pass `false` rather than skipping the call) — a chart that returns early
 * when its container measures zero must still run its hooks in the same order.
 */
export function useProvideAxisNav(active: boolean): void {
  const { retain } = useContext(AxisNavContext);
  useEffect(() => {
    if (!active) return;
    return retain();
  }, [active, retain]);
}

/** Whether to stand down the navigator's own prev/next control. */
export function useAxisNavAvailable(): boolean {
  return useContext(AxisNavContext).available;
}
