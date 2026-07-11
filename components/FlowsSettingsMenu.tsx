"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Settings, Check } from "lucide-react";
import type { SankeyOptions } from "@/components/EnergyFlowSankey";

/** Whether each option can meaningfully apply to the current site (else the toggle is disabled). */
export interface SankeyCapabilities {
  canCombineSolar: boolean; // ≥ 2 solar sources present
  hasBattery: boolean; // a battery source/load node present
}

interface FlowsSettingsMenuProps {
  options: SankeyOptions;
  capabilities: SankeyCapabilities;
  onChange: (next: SankeyOptions) => void;
}

// Shared item styling: pl-8 leaves room for the left check indicator; disabled rows grey out + show a
// not-allowed cursor (their `title` explains why). `onSelect preventDefault` keeps the menu open so both
// options can be toggled in one visit.
const ITEM_CLASS =
  "relative flex items-center gap-2 pl-8 pr-3 py-2 text-sm rounded outline-none cursor-pointer " +
  "text-gray-300 hover:bg-gray-700 data-[highlighted]:bg-gray-700 " +
  "data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed data-[disabled]:hover:bg-transparent";

/**
 * Cog menu next to the "Flows" heading — toggles the Sankey display options (combine solar arrays,
 * battery in the middle). Options that can't apply to the current site are disabled with a tooltip.
 */
export default function FlowsSettingsMenu({
  options,
  capabilities,
  onChange,
}: FlowsSettingsMenuProps) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="rounded p-1 text-gray-500 outline-none transition-colors hover:bg-gray-700 hover:text-gray-300"
          title="Flow display options"
          aria-label="Flow display options"
        >
          <Settings className="h-4 w-4" />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={5}
          className="min-w-[220px] rounded-lg border border-gray-700 bg-gray-800 p-1 shadow-xl"
          style={{
            transform: "translateZ(0)",
            willChange: "transform",
            zIndex: 9999,
          }}
        >
          <DropdownMenu.CheckboxItem
            checked={options.combineSolar}
            disabled={!capabilities.canCombineSolar}
            onCheckedChange={(checked) =>
              onChange({ ...options, combineSolar: checked === true })
            }
            onSelect={(e) => e.preventDefault()}
            className={ITEM_CLASS}
            title={
              capabilities.canCombineSolar
                ? undefined
                : "This site has only one solar array"
            }
          >
            <DropdownMenu.ItemIndicator className="absolute left-2 inline-flex">
              <Check className="h-4 w-4 text-blue-400" />
            </DropdownMenu.ItemIndicator>
            Combine solar arrays
          </DropdownMenu.CheckboxItem>

          <DropdownMenu.CheckboxItem
            checked={options.batteryMiddle}
            disabled={!capabilities.hasBattery}
            onCheckedChange={(checked) =>
              onChange({ ...options, batteryMiddle: checked === true })
            }
            onSelect={(e) => e.preventDefault()}
            className={ITEM_CLASS}
            title={
              capabilities.hasBattery ? undefined : "This site has no battery"
            }
          >
            <DropdownMenu.ItemIndicator className="absolute left-2 inline-flex">
              <Check className="h-4 w-4 text-blue-400" />
            </DropdownMenu.ItemIndicator>
            Battery in the middle
          </DropdownMenu.CheckboxItem>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
