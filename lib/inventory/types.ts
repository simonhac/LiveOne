/** Deliberately excludes credentials, share tokens, vendor payloads and individual readings. */
export interface TreeInventory {
  version: 1;
  generatedAt: string;
  scope: "own" | "fleet";
  sharingIncluded: boolean;
  users: { id: string; name: string; email: string | null }[];
  areas: {
    id: string;
    name: string;
    ownerId: string | null;
    status: string;
    provenance: {
      batteryDays: number;
      batteryLastDay: string | null;
      flowDays: number;
      flowLastDay: string | null;
    };
  }[];
  devices: {
    id: string;
    handle: number;
    name: string;
    vendor: string;
    status: string;
    ownerId: string | null;
    areaId: string | null;
    history: {
      daily: { startDay: string; endDay: string; rows: number } | null;
      lastSuccess: string | null;
    };
  }[];
  points: {
    id: string;
    deviceId: string;
    name: string;
    path: string;
    metric: string;
    unit: string;
    active: boolean;
    control: boolean;
  }[];
  bindings: {
    id: string;
    areaId: string;
    role: string;
    metric: string;
    pointId: string;
    priority: number;
  }[];
  derivations: {
    id: string;
    name: string;
    kind: string;
    role: string | null;
    enabled: boolean;
    deviceIds: string[];
    sources: { slot: string; pointId: string; deviceId: string }[];
    outputPointId: string | null;
    history: {
      intervals: number;
      latest: string | null;
      provenance: { areaId: string; intervals: number }[];
    };
  }[];
  automations: {
    id: string;
    areaId: string;
    name: string;
    enabled: boolean;
    mode: string;
    trigger: string;
    action: string;
    lastTriggered: string | null;
  }[];
  dashboards: {
    id: string;
    name: string;
    ownerId: string;
    areaIds: string[];
    deviceIds: string[];
  }[];
  sharing?: {
    dashboards: {
      id: string;
      recipients: { userId: string; role: string; label?: string }[];
      activeLinks: number;
      areaIds: string[];
      deviceIds: string[];
    }[];
    calendars: { areaId: string; activeLinks: number }[];
  };
  warnings: string[];
}
