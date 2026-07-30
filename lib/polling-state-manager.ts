/**
 * PollingStateManager - Shared client-side state manager for SSE polling events
 *
 * Handles SSE connection, event parsing, and state management for polling operations.
 * Provides a subscribe/unsubscribe pattern for React components to receive updates.
 *
 * Usage:
 *   const manager = new PollingStateManager();
 *   manager.subscribe(state => setPollingState(state));
 *   manager.startPolling('/api/cron/minutely?realTime=true');
 *   // ... later
 *   manager.disconnect();
 */

import type { PollStage } from "@/lib/vendors/types";
import { iso8601Revivor } from "@/lib/json";

// Status of an individual device during polling
export type DevicePollingStatus =
  | "pending"
  | "polling"
  | "completed"
  | "skipped"
  | "error";

// State for a single device
export interface DevicePollingState {
  systemId: number;
  displayName?: string;
  vendorType: string;
  status: DevicePollingStatus;
  sessionLabel?: string;
  sessionId?: string;
  stages?: PollStage[];
  error?: string;
  reason?: string; // For skipped devices
  recordsProcessed?: number;
  durationMs?: number;
  startMs?: number;
  endMs?: number;
  lastPoll?: string | null;
  inProgress?: boolean;
  nextPollTime?: Date;
  rawResponse?: unknown;
}

// Overall polling session state
export interface PollingSessionState {
  isConnected: boolean;
  isComplete: boolean;
  sessionId?: string;
  sessionStartTime?: Date;
  sessionEndTime?: Date;
  durationMs?: number;
  error?: string;
  devices: Map<number, DevicePollingState>;
  summary?: {
    total: number;
    successful: number;
    failed: number;
    skipped: number;
  };
}

// SSE event types from the server (simplified: session-start merged into progress)
type SSEEventType = "start" | "progress" | "complete" | "error";

interface SSEEvent {
  type: SSEEventType;
  data?: any;
  error?: string;
}

type StateListener = (state: PollingSessionState) => void;

export class PollingStateManager {
  private state: PollingSessionState;
  private listeners: Set<StateListener> = new Set();
  private eventSource: EventSource | null = null;
  private abortController: AbortController | null = null;

  constructor() {
    this.state = this.createInitialState();
  }

  private createInitialState(): PollingSessionState {
    return {
      isConnected: false,
      isComplete: false,
      devices: new Map(),
    };
  }

  /**
   * Subscribe to state changes
   * @returns Unsubscribe function
   */
  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    // Immediately call with current state
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Get current state (immutable snapshot)
   */
  getState(): PollingSessionState {
    return {
      ...this.state,
      devices: new Map(this.state.devices),
    };
  }

  /**
   * Get devices as array (convenient for rendering)
   */
  getDevicesArray(): DevicePollingState[] {
    return Array.from(this.state.devices.values());
  }

  private notifyListeners(): void {
    const snapshot = this.getState();
    this.listeners.forEach((listener) => listener(snapshot));
  }

  private updateState(updates: Partial<PollingSessionState>): void {
    this.state = { ...this.state, ...updates };
    this.notifyListeners();
  }

  private updateDevice(
    systemId: number,
    updates: Partial<DevicePollingState>,
  ): void {
    const existing = this.state.devices.get(systemId);
    if (existing) {
      // Merge updates, preserving existing fields (like sessionLabel)
      this.state.devices.set(systemId, { ...existing, ...updates });
    } else {
      // New device entry
      this.state.devices.set(systemId, {
        systemId,
        vendorType: "unknown",
        status: "pending",
        ...updates,
      });
    }
    this.notifyListeners();
  }

  /**
   * Start polling via SSE
   * @param url The SSE endpoint URL
   */
  startPolling(url: string): void {
    // Reset state for new session
    this.state = this.createInitialState();
    this.notifyListeners();

    // Close any existing connection
    this.disconnect();

    // Create abort controller for fetch-based SSE
    this.abortController = new AbortController();

    // Use fetch for SSE to have better control
    this.connectSSE(url);
  }

  private async connectSSE(url: string): Promise<void> {
    try {
      const response = await fetch(url, {
        signal: this.abortController?.signal,
        headers: {
          Accept: "text/event-stream",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error("No response body");
      }

      this.updateState({ isConnected: true });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE messages
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const jsonStr = line.slice(6);
            try {
              const event: SSEEvent = JSON.parse(jsonStr, iso8601Revivor);
              this.handleEvent(event);
            } catch (e) {
              console.error("[PollingStateManager] Failed to parse SSE:", e);
            }
          }
        }
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        // Connection was intentionally closed
        return;
      }

      console.error("[PollingStateManager] SSE error:", error);
      this.updateState({
        isConnected: false,
        error: error instanceof Error ? error.message : "Connection failed",
      });
    }
  }

  private handleEvent(event: SSEEvent): void {
    switch (event.type) {
      case "start":
        this.handleStartEvent(event.data);
        break;
      case "progress":
        // Progress events now include session info (sessionLabel/sessionId)
        this.handleProgressEvent(event.data);
        break;
      case "complete":
        this.handleCompleteEvent(event.data);
        break;
      case "error":
        this.handleErrorEvent(event.error || "Unknown error");
        break;
    }
  }

  private handleStartEvent(data: any): void {
    // Initialize all devices from the start event
    const devicesList = data.devices || [];
    for (const sys of devicesList) {
      this.state.devices.set(sys.systemId, {
        systemId: sys.systemId,
        displayName: sys.displayName,
        vendorType: sys.vendorType,
        status: "pending",
      });
    }

    this.updateState({
      sessionId: data.sessionId,
      sessionStartTime: data.sessionStartTime, // Date object from revivor
    });
  }

  private handleProgressEvent(data: any): void {
    // Determine status based on action and inProgress
    let status: DevicePollingStatus = "polling";
    if (data.action === "ERROR") {
      status = "error";
    } else if (data.action === "SKIPPED") {
      status = "skipped";
    } else if (data.action === "POLLED" && !data.inProgress) {
      status = "completed";
    }

    this.updateDevice(data.systemId, {
      status,
      displayName: data.displayName,
      vendorType: data.vendorType,
      sessionLabel: data.sessionLabel,
      sessionId: data.sessionId,
      stages: data.stages,
      error: data.error,
      reason: data.reason,
      recordsProcessed: data.recordsProcessed,
      durationMs: data.durationMs,
      startMs: data.startMs,
      endMs: data.endMs,
      lastPoll: data.lastPoll,
      inProgress: data.inProgress,
      nextPollTime: data.nextPollTime, // Date from revivor
      rawResponse: data.rawResponse,
    });
  }

  private handleCompleteEvent(data: any): void {
    // Complete event now only has session summary (no results - client already has them from progress)
    // Mark all devices as no longer in progress
    this.state.devices.forEach((sys, systemId) => {
      if (sys.inProgress) {
        this.state.devices.set(systemId, { ...sys, inProgress: false });
      }
    });

    this.updateState({
      isComplete: true,
      isConnected: false,
      sessionEndTime: data.sessionEndTime, // Date object from revivor
      durationMs: data.durationMs,
      summary: data.summary,
    });
  }

  private handleErrorEvent(error: string): void {
    this.updateState({
      isConnected: false,
      error,
    });
  }

  /**
   * Disconnect from SSE and clean up
   */
  disconnect(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.updateState({ isConnected: false });
  }

  /**
   * Reset state without disconnecting
   */
  reset(): void {
    this.state = this.createInitialState();
    this.notifyListeners();
  }
}

// Singleton instance for shared usage
let sharedInstance: PollingStateManager | null = null;

export function getPollingStateManager(): PollingStateManager {
  if (!sharedInstance) {
    sharedInstance = new PollingStateManager();
  }
  return sharedInstance;
}
