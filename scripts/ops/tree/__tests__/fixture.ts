import type { TreeInventory } from "@/lib/inventory/types";
export function fixture(): TreeInventory {
  return {
    version: 1,
    generatedAt: "2026-09-14T00:00:00.000Z",
    scope: "fleet",
    sharingIncluded: true,
    warnings: [],
    users: [
      { id: "simon", name: "Simon", email: "simon@example.com" },
      { id: "craig", name: "Craig", email: "craig@example.com" },
    ],
    areas: [
      {
        id: "ar_home",
        name: "High Street",
        ownerId: "simon",
        status: "active",
        provenance: {
          batteryDays: 120,
          batteryLastDay: "2026-09-13",
          flowDays: 119,
          flowLastDay: "2026-09-13",
        },
      },
      {
        id: "ar_empty",
        name: "Old site",
        ownerId: "craig",
        status: "archived",
        provenance: {
          batteryDays: 0,
          batteryLastDay: null,
          flowDays: 0,
          flowLastDay: null,
        },
      },
    ],
    devices: [
      {
        id: "dv_battery",
        handle: 1,
        name: "Battery inverter",
        vendor: "sigenergy",
        status: "active",
        ownerId: "simon",
        areaId: "ar_home",
        history: {
          daily: { startDay: "2026-05-17", endDay: "2026-09-13", rows: 720 },
          lastSuccess: "2026-09-14T00:00:00.000Z",
        },
      },
      {
        id: "dv_ev",
        handle: 2,
        name: "EV",
        vendor: "tesla",
        status: "removed",
        ownerId: "craig",
        areaId: "ar_home",
        history: { daily: null, lastSuccess: null },
      },
      {
        id: "dv_public",
        handle: 3,
        name: "Grid Victoria",
        vendor: "openelectricity",
        status: "active",
        ownerId: null,
        areaId: null,
        history: { daily: null, lastSuccess: null },
      },
    ],
    points: [
      {
        id: "pt_power",
        deviceId: "dv_battery",
        name: "Power",
        path: "battery/power",
        metric: "power",
        unit: "W",
        active: true,
        control: false,
      },
      {
        id: "pt_stop",
        deviceId: "dv_ev",
        name: "Stop",
        path: "charge/stop",
        metric: "state",
        unit: "",
        active: false,
        control: true,
      },
    ],
    bindings: [
      {
        id: "bn_one",
        areaId: "ar_home",
        role: "battery",
        metric: "power",
        pointId: "pt_power",
        priority: 0,
      },
    ],
    derivations: [
      {
        id: "dx_charge",
        name: "Charging sessions",
        kind: "run-detector",
        role: "ev",
        enabled: false,
        deviceIds: ["dv_battery", "dv_ev"],
        sources: [
          { slot: "signal", pointId: "pt_power", deviceId: "dv_battery" },
          { slot: "boundary", pointId: "pt_stop", deviceId: "dv_ev" },
        ],
        outputPointId: null,
        history: {
          intervals: 42,
          latest: "2026-09-13T10:00:00.000Z",
          provenance: [{ areaId: "ar_home", intervals: 40 }],
        },
      },
    ],
    automations: [
      {
        id: "au_stop",
        areaId: "ar_home",
        name: "Stop charging",
        enabled: true,
        mode: "standing",
        trigger: "charge-session → dx_charge",
        action: "turn_off → pt_stop",
        lastTriggered: "2026-09-13T11:00:00.000Z",
      },
    ],
    dashboards: [
      {
        id: "db_home",
        name: "Home",
        ownerId: "simon",
        areaIds: ["ar_home"],
        deviceIds: [],
      },
    ],
    sharing: {
      dashboards: [
        {
          id: "db_home",
          recipients: [{ userId: "craig", role: "viewer" }],
          activeLinks: 1,
          areaIds: ["ar_home"],
          deviceIds: ["dv_battery"],
        },
      ],
      calendars: [{ areaId: "ar_home", activeLinks: 1 }],
    },
  };
}
