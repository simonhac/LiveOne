import { useState, useEffect, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/queries";
import { Moon } from "lucide-react";
import {
  TESLA_POLL_DEFAULTS,
  MONTHLY_CREDIT,
  CHARGING_HOURS,
  estimatePolls,
  type TeslaPollConfig,
} from "@/lib/vendors/tesla/poll-config";

type TeslaConfig = TeslaPollConfig;
const DEFAULTS = TESLA_POLL_DEFAULTS;

const MIN_MINUTES = 1;
const MAX_MINUTES = 24 * 60;

const formatCost = (n: number): string =>
  n >= 10 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;

// Response from the generic metadata route (GET ?key=tesla).
interface TeslaConfigResponse {
  success: boolean;
  value?: Partial<TeslaConfig> | null;
}

interface TeslaConfigTabProps {
  systemId: number;
  shouldLoad?: boolean;
  onDirtyChange?: (isDirty: boolean) => void;
  onSaveFunctionReady?: (saveFunction: () => Promise<TeslaConfig>) => void;
}

export default function TeslaConfigTab({
  systemId,
  shouldLoad = false,
  onDirtyChange,
  onSaveFunctionReady,
}: TeslaConfigTabProps) {
  const [config, setConfig] = useState<TeslaConfig>(DEFAULTS);
  const [initialConfig, setInitialConfig] = useState<TeslaConfig>(DEFAULTS);

  const configQuery = useQuery({
    queryKey: ["system", systemId, "metadata", "tesla"],
    queryFn: () =>
      fetchJson<TeslaConfigResponse>(
        `/api/admin/devices/${systemId}/metadata?key=tesla`,
      ),
    enabled: shouldLoad && systemId !== -1,
  });

  const loading = systemId !== -1 && configQuery.isPending;

  // Seed editable config from the fetched values, filling any gaps with defaults.
  const configData = configQuery.data;
  useEffect(() => {
    if (configData?.success) {
      const merged: TeslaConfig = { ...DEFAULTS, ...(configData.value ?? {}) };
      setConfig(merged);
      setInitialConfig(merged);
    }
  }, [configData]);

  const isDirty = useMemo(
    () => JSON.stringify(config) !== JSON.stringify(initialConfig),
    [config, initialConfig],
  );
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  const getConfigData = useCallback(
    async (): Promise<TeslaConfig> => config,
    [config],
  );
  useEffect(() => {
    onSaveFunctionReady?.(getConfigData);
  }, [onSaveFunctionReady, getConfigData]);

  // Live cost/poll estimate, recomputed as the user edits the controls.
  const estimate = useMemo(() => estimatePolls(config), [config]);

  const clampMinutes = (raw: string, fallback: number): number => {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, n));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-gray-400">Loading Tesla configuration...</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-400">
        Control how often LiveOne polls this vehicle via the Tesla Fleet API.
        Each poll costs a small amount and waking a sleeping car both costs more
        and drains the battery, so tune these to balance freshness against cost.
      </p>

      {/* Wake to poll toggle */}
      <div className="pt-2">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={config.wakeToPoll}
            onChange={(e) =>
              setConfig((prev) => ({ ...prev, wakeToPoll: e.target.checked }))
            }
            className="mt-0.5 w-5 h-5 rounded border-gray-600 bg-gray-900 text-blue-600 focus:ring-blue-500 focus:ring-offset-gray-800"
          />
          <div>
            <span className="flex items-center gap-2 text-sm font-medium text-gray-300">
              <Moon className="w-4 h-4 text-blue-400" />
              Wake the vehicle to poll
            </span>
            <p className="text-xs text-gray-400 mt-0.5">
              When on, a sleeping car is woken on every poll (most data, but
              each wake costs ~$0.02 and prevents the car from sleeping). When
              off, LiveOne only reads data while the car is already awake and
              records a gap otherwise — cheapest, and lets the car sleep.
            </p>
          </div>
        </label>
      </div>

      {/* Poll intervals */}
      <div className="grid grid-cols-2 gap-4 pt-2 border-t border-gray-700">
        <div className="mt-4">
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Idle interval (min)
          </label>
          <input
            type="number"
            min={MIN_MINUTES}
            max={MAX_MINUTES}
            value={config.idlePollMinutes}
            onChange={(e) =>
              setConfig((prev) => ({
                ...prev,
                idlePollMinutes: clampMinutes(
                  e.target.value,
                  DEFAULTS.idlePollMinutes,
                ),
              }))
            }
            className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-md text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <p className="text-xs text-gray-400 mt-1">
            How often to poll when not charging. Default{" "}
            {DEFAULTS.idlePollMinutes}.
          </p>
        </div>

        <div className="mt-4">
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Charging interval (min)
          </label>
          <input
            type="number"
            min={MIN_MINUTES}
            max={MAX_MINUTES}
            value={config.chargingPollMinutes}
            onChange={(e) =>
              setConfig((prev) => ({
                ...prev,
                chargingPollMinutes: clampMinutes(
                  e.target.value,
                  DEFAULTS.chargingPollMinutes,
                ),
              }))
            }
            className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-md text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <p className="text-xs text-gray-400 mt-1">
            Faster cadence while the car is charging. Default{" "}
            {DEFAULTS.chargingPollMinutes}.
          </p>
        </div>
      </div>

      {/* Live estimate */}
      <div className="mt-2 rounded-lg border border-gray-700 bg-gray-900/50 px-3 py-2.5">
        <p className="text-sm text-gray-200">
          ≈ {Math.round(estimate.pollsPerDay)} polls/day · est.{" "}
          {formatCost(estimate.monthlyCost)}/mo via the Fleet API
          {estimate.monthlyCost <= MONTHLY_CREDIT ? (
            <> — within the ${MONTHLY_CREDIT}/mo credit</>
          ) : (
            <>
              {" "}
              — ≈ {formatCost(estimate.monthlyAfterCredit)}/mo after the $
              {MONTHLY_CREDIT} credit
            </>
          )}
        </p>
        <p className="text-xs text-gray-500 mt-1">
          Assumes {CHARGING_HOURS} h/day charging and the car asleep when idle.
          Actual cost depends on how often it&apos;s awake.
        </p>
      </div>
    </div>
  );
}
