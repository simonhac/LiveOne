"use client";

import { useEffect, useState } from "react";
import { Fuel, Settings } from "lucide-react";
import Tile from "@/components/Tile";
import GeneratorControlDialog from "@/components/GeneratorControlDialog";
import { IDLE_CHROME, ROLE_CHROME } from "@/lib/role-chrome";
import {
  GENERATOR_CONTROL_PATHS,
  GENERATOR_MODE_PATH,
  GENERATOR_RPM_PATHS,
  GENERATOR_STATUS_PATH,
  GENERATOR_STOP_AT_PATH,
  GENERATOR_ERROR_PATH,
  firstPresentPath,
  generatorTileLine,
} from "@/lib/control/generator-ref";
import type { TilePlugin, TileRenderProps } from "./types";
import { getMeasurementTime, getPointValue, getTextValue } from "./shared";

/**
 * The generator tile — engine state at a glance, plus the cog that opens the run controls.
 *
 * Chrome is `ROLE_CHROME.neutral`, which lib/role-chrome.ts reserves for "tiles with no series of
 * their own": the generator has no entry in `CHART_COLORS`, and inventing one to tint a tile would
 * be a palette decision made for the wrong reason. State therefore rides entirely on the label and
 * on the countdown's colour — the amber-on-neutral treatment `TeslaSmallCard` already uses for its
 * armed charge limit — which is also exactly what that module's "identity, not state" rule asks for.
 *
 * The value is engine rpm, because it is the one number that says *the engine is actually turning*
 * independently of anything the hub believes. The DeepSea's other metrics (oil, coolant, fuel,
 * battery) are already on the dashboard in the `device-metrics` card bound to the same device, so
 * this tile deliberately does not repeat them.
 */
function GeneratorTile({
  latest,
  systemId,
  canControl,
  staleThresholdSeconds,
}: TileRenderProps) {
  const [controlsOpen, setControlsOpen] = useState(false);

  const state = getTextValue(latest, GENERATOR_STATUS_PATH);
  const mode = getTextValue(latest, GENERATOR_MODE_PATH);
  const stopAt = getPointValue(latest, GENERATOR_STOP_AT_PATH);
  // Resolved rather than hardcoded: the readings still arrive on the pre-#150 logical path on
  // prod. See GENERATOR_RPM_PATHS.
  const rpmPath = firstPresentPath(latest, GENERATOR_RPM_PATHS);
  const rpm = rpmPath ? getPointValue(latest, rpmPath) : null;
  const lastError = getTextValue(latest, GENERATOR_ERROR_PATH);

  // A commanded run's countdown must tick without waiting for the next 15 s push, and `stop_at` is
  // an absolute instant, so re-rendering on a clock is enough — there is nothing to re-fetch.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);

  const line = generatorTileLine({
    state,
    mode,
    stopAtEpochSec: stopAt,
    nowMs,
  });
  const running = line.tone === "running" || line.tone === "commanded";
  const chrome = running ? ROLE_CHROME.neutral : IDLE_CHROME;
  const showControls = canControl && systemId != null;

  return (
    <div className="relative">
      <Tile
        title="Generator"
        // rpm is the honest "is it turning" number; an em-dash beats a confident 0 when the
        // register has not been read at all.
        value={rpm == null ? "—" : String(Math.round(rpm))}
        unit={rpm == null ? undefined : "rpm"}
        icon={<Fuel className="w-6 h-6" />}
        iconColor={chrome.icon}
        bgColor={chrome.tint}
        borderColor={chrome.border}
        staleThresholdSeconds={staleThresholdSeconds}
        measurementTime={
          getMeasurementTime(latest, GENERATOR_STATUS_PATH) ?? undefined
        }
        extra={
          <div
            className={`text-xs ${
              line.tone === "warning"
                ? "text-red-400"
                : line.tone === "commanded"
                  ? "text-amber-400/90"
                  : "text-gray-400"
            }`}
          >
            {line.text}
            {/* The error TEXT lives in the dialog, where there is room for a sentence; out here it
                is only a signal that there is something to go and read. */}
            {lastError && (
              <span
                aria-label="The generator hub reported an error"
                className="ml-1 text-red-400"
              >
                ●
              </span>
            )}
          </div>
        }
      />

      {showControls && (
        <>
          {/* Bottom-right: the tile's own icon owns the top-right corner on desktop, and the
              value/state column is left-aligned, so this is the one corner that is always free. */}
          <button
            type="button"
            onClick={() => setControlsOpen(true)}
            aria-label="Generator controls"
            className="absolute bottom-2 right-2 z-20 flex items-center justify-center text-gray-500 transition-colors hover:text-gray-200"
          >
            <Settings className="h-4 w-4" />
          </button>
          <GeneratorControlDialog
            systemId={systemId as number}
            open={controlsOpen}
            onOpenChange={setControlsOpen}
            latest={latest}
          />
        </>
      )}
    </div>
  );
}

export const generatorTile: TilePlugin = {
  kind: "tile",
  type: "generator",
  // The hub's control-state point is the gate rather than any engine register: it is pushed by the
  // supervisor itself (merged in tickOnce, NOT produced inside read()), so it is present even
  // during the Modbus outage that would blank every other generator point — which is precisely
  // when a user most wants the tile to still be there saying `stop-failing`.
  isAvailable: ({ latest }) =>
    getTextValue(latest, GENERATOR_STATUS_PATH) !== null,
  controlPaths: GENERATOR_CONTROL_PATHS,
  Render: GeneratorTile,
};
