"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Layers } from "lucide-react";

/** Minimal device shape the rail needs — kept local so this client file never imports server types. */
interface RailDevice {
  id: number;
  displayName: string;
  vendorSiteId: string;
  vendorType: string;
  ownerClerkUserId?: string | null;
  alias?: string | null;
  ownerUsername?: string | null;
}

type FilterKey = "mine" | "shared" | "public";

const FILTER_ORDER: readonly FilterKey[] = ["mine", "shared", "public"];
const FILTER_LABELS: Record<FilterKey, string> = {
  mine: "My devices",
  shared: "Shared",
  public: "Public",
};
const DEFAULT_FILTERS: Record<FilterKey, boolean> = {
  mine: true,
  shared: true,
  public: false,
};
const STORAGE_KEY = "deviceRail.filters";

/** Coerce an arbitrary parsed value back to a valid, non-empty filter set. */
function coerceFilters(raw: unknown): Record<FilterKey, boolean> {
  const next = { ...DEFAULT_FILTERS };
  if (raw && typeof raw === "object") {
    for (const key of FILTER_ORDER) {
      const v = (raw as Record<string, unknown>)[key];
      if (typeof v === "boolean") next[key] = v;
    }
  }
  // Never zero-selected — fall back to "My devices" if the persisted set was empty/invalid.
  if (!next.mine && !next.shared && !next.public) next.mine = true;
  return next;
}

function groupOf(device: RailDevice, currentUserId: string): FilterKey {
  if (device.ownerClerkUserId == null) return "public";
  if (device.ownerClerkUserId === currentUserId) return "mine";
  return "shared";
}

function isActive(device: RailDevice, pathname: string): boolean {
  const numericBase = `/device/${device.id}`;
  if (pathname === numericBase || pathname.startsWith(`${numericBase}/`)) {
    return true;
  }
  if (device.ownerUsername && device.alias) {
    const prettyBase = `/device/${device.ownerUsername}/${device.alias}`;
    if (pathname === prettyBase || pathname.startsWith(`${prettyBase}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * The persistent left rail of the device view (rendered by `app/device/layout.tsx`). Lists the viewer's
 * visible devices grouped into My / Shared / Public, with a top switcher that turns each group on/off
 * (never all off). Rows are plain `<Link>`s: under the shared layout, clicking swaps only the page
 * content (cards) while the rail stays mounted, and the URL becomes `/device/{id|user/alias}`.
 */
export default function DeviceRail({
  devices,
  currentUserId,
}: {
  devices: RailDevice[];
  currentUserId: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const period = searchParams.get("period");

  const [filters, setFilters] =
    useState<Record<FilterKey, boolean>>(DEFAULT_FILTERS);

  // Load persisted filters after mount (avoids an SSR/hydration mismatch on localStorage).
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) setFilters(coerceFilters(JSON.parse(stored)));
    } catch {
      // ignore malformed storage
    }
  }, []);

  const persist = (next: Record<FilterKey, boolean>) => {
    setFilters(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore storage failures (private mode, quota, …)
    }
  };

  const toggle = (key: FilterKey) => {
    const next = { ...filters, [key]: !filters[key] };
    // Enforce "never zero-selected": ignore a toggle that would clear the last active group.
    if (!next.mine && !next.shared && !next.public) return;
    persist(next);
  };

  // Which groups have at least one device (so we only show a toggle that can do something).
  const present: Record<FilterKey, RailDevice[]> = {
    mine: [],
    shared: [],
    public: [],
  };
  for (const d of devices) {
    present[groupOf(d, currentUserId)].push(d);
  }
  for (const key of FILTER_ORDER) {
    present[key].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  const hrefFor = (device: RailDevice): string => {
    const base =
      device.ownerUsername && device.alias
        ? `/device/${device.ownerUsername}/${device.alias}`
        : `/device/${device.id}`;
    return period ? `${base}?period=${encodeURIComponent(period)}` : base;
  };

  const renderGroup = (key: FilterKey) => {
    if (!filters[key]) return null;
    const items = present[key];
    if (items.length === 0) return null;
    return (
      <div key={key} className="mb-3">
        <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
          {FILTER_LABELS[key]}
        </div>
        <div className="space-y-0.5">
          {items.map((device) => {
            const active = isActive(device, pathname);
            return (
              <Link
                key={device.id}
                href={hrefFor(device)}
                className={`block truncate rounded-md px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "bg-gray-800 font-medium text-white"
                    : "text-gray-300 hover:bg-gray-800/60 hover:text-white"
                }`}
                title={device.displayName || device.vendorSiteId}
              >
                {device.displayName || `System ${device.vendorSiteId}`}
              </Link>
            );
          })}
        </div>
      </div>
    );
  };

  const hasAnyVisible = FILTER_ORDER.some(
    (key) => filters[key] && present[key].length > 0,
  );

  return (
    <nav className="flex h-full flex-col py-3">
      <div className="px-3 pb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
        Devices
      </div>

      {/* Group switcher — independent toggles, never all off. */}
      <div className="mb-3 flex flex-wrap gap-1 px-3">
        {FILTER_ORDER.map((key) => {
          const on = filters[key];
          return (
            <button
              key={key}
              type="button"
              onClick={() => toggle(key)}
              aria-pressed={on}
              className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                on
                  ? "border-blue-500/60 bg-blue-600/20 text-blue-200"
                  : "border-gray-700 text-gray-400 hover:border-gray-600 hover:text-gray-200"
              }`}
            >
              {FILTER_LABELS[key]}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {FILTER_ORDER.map(renderGroup)}
        {!hasAnyVisible && (
          <div className="px-3 py-4 text-sm text-gray-500">No devices.</div>
        )}
      </div>

      {/* Manage the viewer's Areas/sites — mirrors the header switcher's footer. */}
      <div className="mt-2 border-t border-gray-800 pt-2">
        <Link
          href="/areas"
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-400 transition-colors hover:text-white"
        >
          <Layers className="h-4 w-4" />
          Manage sites
        </Link>
      </div>
    </nav>
  );
}
