import { describe, it, expect, beforeEach, jest } from "@jest/globals";
import {
  PollingStateManager,
  getPollingStateManager,
  type PollingSessionState,
  type SystemPollingState,
} from "../polling-state-manager";

// Reset the singleton between tests
let savedSharedInstance: PollingStateManager | null = null;

describe("PollingStateManager", () => {
  let manager: PollingStateManager;

  beforeEach(() => {
    manager = new PollingStateManager();
  });

  describe("initial state", () => {
    it("should have correct initial state", () => {
      const state = manager.getState();
      expect(state.isConnected).toBe(false);
      expect(state.isComplete).toBe(false);
      expect(state.systems.size).toBe(0);
      expect(state.error).toBeUndefined();
    });
  });

  describe("subscribe", () => {
    it("should call listener immediately with current state", () => {
      const listener = jest.fn();
      manager.subscribe(listener);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          isConnected: false,
          isComplete: false,
        }),
      );
    });

    it("should return unsubscribe function", () => {
      const listener = jest.fn();
      const unsubscribe = manager.subscribe(listener);

      expect(typeof unsubscribe).toBe("function");
    });

    it("should stop receiving updates after unsubscribe", () => {
      const listener = jest.fn();
      const unsubscribe = manager.subscribe(listener);

      // Initial call
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();

      // Reset should not notify unsubscribed listener
      manager.reset();
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe("getState", () => {
    it("should return immutable snapshot", () => {
      const state1 = manager.getState();
      const state2 = manager.getState();

      // Different object references
      expect(state1).not.toBe(state2);
      expect(state1.systems).not.toBe(state2.systems);
    });
  });

  describe("getSystemsArray", () => {
    it("should return empty array initially", () => {
      const systems = manager.getSystemsArray();
      expect(systems).toEqual([]);
    });
  });

  describe("reset", () => {
    it("should reset state to initial values", () => {
      // Manually modify state through internal methods (via handleEvent simulation)
      manager.reset();

      const state = manager.getState();
      expect(state.isConnected).toBe(false);
      expect(state.isComplete).toBe(false);
      expect(state.systems.size).toBe(0);
    });

    it("should notify listeners on reset", () => {
      const listener = jest.fn();
      manager.subscribe(listener);
      listener.mockClear();

      manager.reset();

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe("disconnect", () => {
    it("should set isConnected to false", () => {
      // Access private method to set connected state for testing
      (manager as any).updateState({ isConnected: true });
      expect(manager.getState().isConnected).toBe(true);

      manager.disconnect();
      expect(manager.getState().isConnected).toBe(false);
    });
  });
});

describe("Event handling (internal)", () => {
  let manager: PollingStateManager;

  beforeEach(() => {
    manager = new PollingStateManager();
  });

  describe("handleStartEvent", () => {
    it("should initialize systems from start event", () => {
      const testDate = new Date("2025-11-29T12:00:00+10:00");
      const startData = {
        sessionId: "abc12/1",
        sessionStartTime: testDate, // Date object (from iso8601Revivor)
        systems: [
          { systemId: 1, displayName: "System 1", vendorType: "selectronic" },
          { systemId: 2, displayName: "System 2", vendorType: "enphase" },
        ],
      };

      // Access private method
      (manager as any).handleStartEvent(startData);

      const state = manager.getState();
      expect(state.sessionId).toBe("abc12/1");
      expect(state.sessionStartTime).toEqual(testDate);
      expect(state.systems.size).toBe(2);

      const sys1 = state.systems.get(1);
      expect(sys1).toEqual({
        systemId: 1,
        displayName: "System 1",
        vendorType: "selectronic",
        status: "pending",
      });
    });
  });

  describe("handleProgressEvent", () => {
    it("should update system with progress data", () => {
      // Initialize system
      (manager as any).handleStartEvent({
        systems: [{ systemId: 1, displayName: "Sys 1", vendorType: "test" }],
      });

      // Progress event
      (manager as any).handleProgressEvent({
        systemId: 1,
        action: "POLLED",
        inProgress: true,
        sessionLabel: "abc12/1.1",
        stages: [{ name: "login", startMs: 100, endMs: 200 }],
      });

      const sys = manager.getState().systems.get(1);
      expect(sys?.status).toBe("polling");
      expect(sys?.sessionLabel).toBe("abc12/1.1");
      expect(sys?.stages).toHaveLength(1);
    });

    it("should set error status on ERROR action", () => {
      (manager as any).handleStartEvent({
        systems: [{ systemId: 1, displayName: "Sys 1", vendorType: "test" }],
      });

      (manager as any).handleProgressEvent({
        systemId: 1,
        action: "ERROR",
        error: "Connection failed",
      });

      const sys = manager.getState().systems.get(1);
      expect(sys?.status).toBe("error");
      expect(sys?.error).toBe("Connection failed");
    });

    it("should set skipped status on SKIPPED action", () => {
      (manager as any).handleStartEvent({
        systems: [{ systemId: 1, displayName: "Sys 1", vendorType: "test" }],
      });

      (manager as any).handleProgressEvent({
        systemId: 1,
        action: "SKIPPED",
        reason: "Recently polled",
      });

      const sys = manager.getState().systems.get(1);
      expect(sys?.status).toBe("skipped");
      expect(sys?.reason).toBe("Recently polled");
    });

    it("should set completed status when POLLED and not inProgress", () => {
      (manager as any).handleStartEvent({
        systems: [{ systemId: 1, displayName: "Sys 1", vendorType: "test" }],
      });

      (manager as any).handleProgressEvent({
        systemId: 1,
        action: "POLLED",
        inProgress: false,
        recordsProcessed: 16,
      });

      const sys = manager.getState().systems.get(1);
      expect(sys?.status).toBe("completed");
      expect(sys?.recordsProcessed).toBe(16);
    });

    it("should include sessionLabel in progress events", () => {
      (manager as any).handleStartEvent({
        systems: [{ systemId: 1, displayName: "Sys 1", vendorType: "test" }],
      });

      // First progress event includes sessionLabel (merged from old session-start)
      (manager as any).handleProgressEvent({
        systemId: 1,
        action: "POLLED",
        inProgress: true,
        sessionLabel: "abc12/1.1",
        sessionId: 123,
        stages: [{ name: "login", startMs: 100, endMs: 200 }],
      });

      const sys = manager.getState().systems.get(1);
      expect(sys?.status).toBe("polling");
      expect(sys?.sessionLabel).toBe("abc12/1.1");
      expect(sys?.sessionId).toBe(123);
    });
  });

  describe("handleCompleteEvent", () => {
    it("should update state with completion data (no results - client has them from progress)", () => {
      (manager as any).handleStartEvent({
        systems: [{ systemId: 1, displayName: "Sys 1", vendorType: "test" }],
      });

      // Simulate progress event that would have happened before complete
      (manager as any).handleProgressEvent({
        systemId: 1,
        action: "POLLED",
        inProgress: false,
        sessionLabel: "abc12/1.1",
        recordsProcessed: 16,
      });

      // Complete event now only has summary (no results array)
      const endTime = new Date("2025-11-29T12:00:02+10:00");
      (manager as any).handleCompleteEvent({
        sessionEndTime: endTime, // Date object (from iso8601Revivor)
        durationMs: 1000,
        summary: {
          total: 1,
          successful: 1,
          failed: 0,
          skipped: 0,
        },
      });

      const state = manager.getState();
      expect(state.isComplete).toBe(true);
      expect(state.isConnected).toBe(false);
      expect(state.sessionEndTime).toEqual(endTime);
      expect(state.durationMs).toBe(1000);
      expect(state.summary).toEqual({
        total: 1,
        successful: 1,
        failed: 0,
        skipped: 0,
      });

      // System state came from progress event, not complete
      const sys = state.systems.get(1);
      expect(sys?.status).toBe("completed");
      expect(sys?.sessionLabel).toBe("abc12/1.1");
    });
  });

  describe("handleErrorEvent", () => {
    it("should set session-level error", () => {
      (manager as any).handleErrorEvent("Connection refused");

      const state = manager.getState();
      expect(state.isConnected).toBe(false);
      expect(state.error).toBe("Connection refused");
    });
  });
});

describe("getPollingStateManager singleton", () => {
  it("should return the same instance on multiple calls", () => {
    const instance1 = getPollingStateManager();
    const instance2 = getPollingStateManager();
    expect(instance1).toBe(instance2);
  });
});
