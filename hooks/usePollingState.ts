"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  PollingStateManager,
  getPollingStateManager,
  type PollingSessionState,
  type SystemPollingState,
} from "@/lib/polling-state-manager";

export type { PollingSessionState, SystemPollingState };

interface UsePollingStateOptions {
  /** Use a shared singleton instance (default: true) */
  shared?: boolean;
  /** Auto-subscribe on mount (default: true) */
  autoSubscribe?: boolean;
}

interface UsePollingStateReturn {
  /** Current polling session state */
  state: PollingSessionState;
  /** Systems as array for easy rendering */
  systems: SystemPollingState[];
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
  /** Get a specific system's state */
  getSystem: (systemId: number) => SystemPollingState | undefined;
}

/**
 * React hook for consuming PollingStateManager
 *
 * Usage:
 *   const { state, systems, startPolling, disconnect } = usePollingState();
 *
 *   // Start polling
 *   startPolling('/api/cron/minutely?realTime=true&systemId=1');
 *
 *   // Render systems
 *   {systems.map(sys => <SystemRow key={sys.systemId} system={sys} />)}
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

  // Memoized systems array
  const systems = useMemo(() => {
    return Array.from(state.systems.values());
  }, [state.systems]);

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

  const getSystem = useCallback(
    (systemId: number) => {
      return state.systems.get(systemId);
    },
    [state.systems],
  );

  return {
    state,
    systems,
    isConnected: state.isConnected,
    isComplete: state.isComplete,
    error: state.error,
    startPolling,
    disconnect,
    reset,
    getSystem,
  };
}

/**
 * Hook for polling a single system
 * Convenience wrapper that extracts just the relevant system's state
 */
export function useSingleSystemPolling(systemId: number | null) {
  const { state, startPolling, disconnect, reset, getSystem } =
    usePollingState();

  const systemState = useMemo(() => {
    if (systemId === null) return null;
    return getSystem(systemId) || null;
  }, [systemId, getSystem]);

  const startSinglePoll = useCallback(
    (force = false, dryRun = false) => {
      if (systemId === null) return;
      const params = new URLSearchParams({
        realTime: "true",
        systemId: String(systemId),
      });
      if (force) params.set("force", "true");
      if (dryRun) params.set("dryRun", "true");
      startPolling(`/api/cron/minutely?${params}`);
    },
    [systemId, startPolling],
  );

  return {
    sessionState: state,
    systemState,
    isConnected: state.isConnected,
    isComplete: state.isComplete,
    error: state.error || systemState?.error,
    startPolling: startSinglePoll,
    disconnect,
    reset,
  };
}
