"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  PollingStateManager,
  getPollingStateManager,
  type PollingSessionState,
  type DevicePollingState,
} from "@/lib/polling-state-manager";

export type { PollingSessionState, DevicePollingState };

interface UsePollingStateOptions {
  /** Use a shared singleton instance (default: true) */
  shared?: boolean;
  /** Auto-subscribe on mount (default: true) */
  autoSubscribe?: boolean;
}

interface UsePollingStateReturn {
  /** Current polling session state */
  state: PollingSessionState;
  /** Devices as array for easy rendering */
  devices: DevicePollingState[];
  /** Whether SSE is connected */
  isConnected: boolean;
  /** Whether polling session is complete */
  isComplete: boolean;
  /** Session-level error if any */
  error?: string;
  /** Start polling from URL */
  startPolling: (url: string) => void;
  /** Disconnect SSE */
  disconnect: () => void;
  /** Reset state */
  reset: () => void;
  /** Get a specific device's state */
  getDevice: (systemId: number) => DevicePollingState | undefined;
}

/**
 * React hook for consuming PollingStateManager
 *
 * Usage:
 *   const { state, devices, startPolling, disconnect } = usePollingState();
 *
 *   // Start polling
 *   startPolling('/api/cron/minutely?realTime=true&systemId=1');
 *
 *   // Render devices
 *   {systems.map(sys => <DeviceRow key={sys.systemId} device={sys} />)}
 */
export function usePollingState(
  options: UsePollingStateOptions = {},
): UsePollingStateReturn {
  const { shared = true, autoSubscribe = true } = options;

  // Create or get manager instance
  const manager = useMemo(() => {
    return shared ? getPollingStateManager() : new PollingStateManager();
  }, [shared]);

  // State that React will re-render on
  const [state, setState] = useState<PollingSessionState>(() =>
    manager.getState(),
  );

  // Subscribe to manager updates
  useEffect(() => {
    if (!autoSubscribe) return;

    const unsubscribe = manager.subscribe((newState) => {
      setState(newState);
    });

    return () => {
      unsubscribe();
      // If not shared, disconnect on unmount
      if (!shared) {
        manager.disconnect();
      }
    };
  }, [manager, autoSubscribe, shared]);

  // Memoized devices array
  const devices = useMemo(() => {
    return Array.from(state.devices.values());
  }, [state.devices]);

  // Callbacks
  const startPolling = useCallback(
    (url: string) => {
      manager.startPolling(url);
    },
    [manager],
  );

  const disconnect = useCallback(() => {
    manager.disconnect();
  }, [manager]);

  const reset = useCallback(() => {
    manager.reset();
  }, [manager]);

  const getDevice = useCallback(
    (systemId: number) => {
      return state.devices.get(systemId);
    },
    [state.devices],
  );

  return {
    state,
    devices,
    isConnected: state.isConnected,
    isComplete: state.isComplete,
    error: state.error,
    startPolling,
    disconnect,
    reset,
    getDevice,
  };
}
