import { useState, useEffect, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/queries";
import { CAPABILITIES, type CapabilityId } from "@/lib/capabilities/registry";
import type { DeviceConfig } from "@/lib/capabilities/config";

// Editor for the typed per-device `systems.config` (DeviceConfig) blob: capability on/off overrides
// + nameplateKw + updateCadenceSeconds. Mirrors TeslaConfigTab's shape — the parent SystemSettingsDialog
// drives it via the onDirtyChange / onSaveFunctionReady handshake and PATCHes the returned config.

interface ConfigResponse {
  success: boolean;
  config?: DeviceConfig | null;
  derived?: string[];
}

type CapState = "default" | "on" | "off";

const CAP_ENTRIES = Object.values(CAPABILITIES);
const ATOMIC_CAPS = CAP_ENTRIES.filter((c) => c.tier === "atomic");
const COMPOUND_CAPS = CAP_ENTRIES.filter((c) => c.tier === "compound");

// Build a cleaned DeviceConfig from the editor's local state (drops empty capabilities + blank/invalid
// numbers), matching what the /config route persists.
function buildConfig(
  caps: Partial<Record<CapabilityId, boolean>>,
  nameplateStr: string,
  cadenceStr: string,
): DeviceConfig {
  const out: DeviceConfig = {};

  const cleanCaps = Object.fromEntries(
    Object.entries(caps).filter(([, v]) => typeof v === "boolean"),
  ) as Partial<Record<CapabilityId, boolean>>;
  if (Object.keys(cleanCaps).length > 0) out.capabilities = cleanCaps;

  const np = parseFloat(nameplateStr);
  if (nameplateStr.trim() !== "" && Number.isFinite(np) && np > 0)
    out.nameplateKw = np;

  const cad = parseFloat(cadenceStr);
  if (cadenceStr.trim() !== "" && Number.isFinite(cad) && cad > 0)
    out.updateCadenceSeconds = cad;

  return out;
}

interface DeviceConfigTabProps {
  systemId: number;
  shouldLoad?: boolean;
  onDirtyChange?: (isDirty: boolean) => void;
  onSaveFunctionReady?: (saveFunction: () => Promise<DeviceConfig>) => void;
}

export default function DeviceConfigTab({
  systemId,
  shouldLoad = false,
  onDirtyChange,
  onSaveFunctionReady,
}: DeviceConfigTabProps) {
  const [caps, setCaps] = useState<Partial<Record<CapabilityId, boolean>>>({});
  const [nameplateStr, setNameplateStr] = useState("");
  const [cadenceStr, setCadenceStr] = useState("");
  const [initialJson, setInitialJson] = useState("{}");
  const [derived, setDerived] = useState<Set<CapabilityId>>(new Set());

  const configQuery = useQuery({
    queryKey: ["system", systemId, "config"],
    queryFn: () =>
      fetchJson<ConfigResponse>(`/api/admin/systems/${systemId}/config`),
    enabled: shouldLoad && systemId !== -1,
  });

  const loading = systemId !== -1 && configQuery.isPending;

  // Seed editable state from the fetched config.
  const data = configQuery.data;
  useEffect(() => {
    if (!data?.success) return;
    const cfg = data.config ?? {};
    const seededCaps = cfg.capabilities ?? {};
    const seededNp = cfg.nameplateKw != null ? String(cfg.nameplateKw) : "";
    const seededCad =
      cfg.updateCadenceSeconds != null ? String(cfg.updateCadenceSeconds) : "";
    setCaps(seededCaps);
    setNameplateStr(seededNp);
    setCadenceStr(seededCad);
    setInitialJson(
      JSON.stringify(buildConfig(seededCaps, seededNp, seededCad)),
    );
    setDerived(new Set((data.derived ?? []) as CapabilityId[]));
  }, [data]);

  const current = useMemo(
    () => buildConfig(caps, nameplateStr, cadenceStr),
    [caps, nameplateStr, cadenceStr],
  );
  const isDirty = useMemo(
    () => JSON.stringify(current) !== initialJson,
    [current, initialJson],
  );
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  const getConfigData = useCallback(
    async (): Promise<DeviceConfig> => current,
    [current],
  );
  useEffect(() => {
    onSaveFunctionReady?.(getConfigData);
  }, [onSaveFunctionReady, getConfigData]);

  const setCapState = (id: CapabilityId, state: CapState) => {
    setCaps((prev) => {
      const next = { ...prev };
      if (state === "default") delete next[id];
      else next[id] = state === "on";
      return next;
    });
  };
  const stateOf = (id: CapabilityId): CapState =>
    caps[id] === true ? "on" : caps[id] === false ? "off" : "default";

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-gray-400">Loading configuration...</div>
      </div>
    );
  }

  const renderCapRow = (def: (typeof CAP_ENTRIES)[number]) => {
    const id = def.id;
    const state = stateOf(id);
    return (
      <div key={id} className="flex items-center justify-between gap-3 py-1.5">
        <div className="min-w-0">
          <div className="text-sm text-gray-200">{def.label}</div>
          <div className="text-xs text-gray-500">
            Default · {derived.has(id) ? "on" : "off"}
            {def.tier === "compound" ? " · force off to hide" : ""}
          </div>
        </div>
        <div className="flex shrink-0 overflow-hidden rounded-md border border-gray-700">
          {(["default", "on", "off"] as const).map((opt) => {
            const active = state === opt;
            const activeCls =
              opt === "on"
                ? "bg-green-600 text-white"
                : opt === "off"
                  ? "bg-red-600 text-white"
                  : "bg-gray-600 text-white";
            return (
              <button
                key={opt}
                type="button"
                onClick={() => setCapState(id, opt)}
                className={`px-3 py-1 text-xs font-medium transition-colors ${
                  active
                    ? activeCls
                    : "bg-gray-900 text-gray-400 hover:text-gray-200"
                }`}
              >
                {opt === "default" ? "Default" : opt === "on" ? "On" : "Off"}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-400">
        Per-device configuration. Capability overrides force a card on or off
        instead of deriving it from the device&apos;s points; the sizing and
        cadence knobs tune the chart scaling and stale threshold.
      </p>

      {/* Capabilities */}
      <div>
        <h3 className="mb-1 text-sm font-medium text-gray-300">Capabilities</h3>
        <p className="mb-2 text-xs text-gray-500">
          “Default” derives the capability from the device&apos;s points; “On”
          forces it, “Off” hides it.
        </p>
        <div className="divide-y divide-gray-700/60 rounded-md border border-gray-700 px-3">
          {ATOMIC_CAPS.map(renderCapRow)}
        </div>

        {COMPOUND_CAPS.length > 0 && (
          <>
            <p className="mt-3 mb-2 text-xs text-gray-500">
              Compound cards (derived from trackers / grid location) — override
              off to hide.
            </p>
            <div className="divide-y divide-gray-700/60 rounded-md border border-gray-700 px-3">
              {COMPOUND_CAPS.map(renderCapRow)}
            </div>
          </>
        )}
      </div>

      {/* Sizing + cadence */}
      <div className="grid grid-cols-2 gap-4 border-t border-gray-700 pt-4">
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-300">
            Nameplate (kW)
          </label>
          <input
            type="number"
            min={0}
            step="0.1"
            value={nameplateStr}
            onChange={(e) => setNameplateStr(e.target.value)}
            placeholder="derive from ratings"
            className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-gray-100 placeholder:text-gray-600 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="mt-1 text-xs text-gray-500">
            Sets the power chart&apos;s y-axis max. Blank = derive from the
            device&apos;s ratings.
          </p>
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-gray-300">
            Update cadence (s)
          </label>
          <input
            type="number"
            min={0}
            step="1"
            value={cadenceStr}
            onChange={(e) => setCadenceStr(e.target.value)}
            placeholder="default 300"
            className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-gray-100 placeholder:text-gray-600 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="mt-1 text-xs text-gray-500">
            How stale a tile can get before it dims. Blank = vendor default
            (Enphase 2100, else 300).
          </p>
        </div>
      </div>
    </div>
  );
}
