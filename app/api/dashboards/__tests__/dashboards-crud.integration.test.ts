/**
 * Integration tests for the composition-dashboard CRUD surface (Phase 2b-2 + dashboard-creation-config).
 *
 * Exercises a real running server (TEST_BASE_URL) with the `x-claude` dev-auth bypass:
 * - create (+ seedAreaId escalation reject)
 * - alias collision (409)
 * - rename
 * - no-escalation card reject (403)
 * - sankey on a sidebar-vendor area is KEPT (it works for any area with loads + sources; v3 doesn't drop)
 * - default set + UNSET via /api/user/preferences
 * - delete (then 404)
 *
 * Each test creates its own rows and cleans them up. Requires a live dev server + a readable Area for
 * the vendor-gating/escalation cases (mirrors points.integration.test.ts pulling a live fixture).
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";
const AUTH = { "x-claude": "true", "Content-Type": "application/json" };

const createdIds: number[] = [];

function uniqueAlias(): string {
  // No Date.now()/Math.random ban here (test file), but keep it collision-resistant across runs.
  return `it-${Math.random().toString(36).slice(2, 10)}`;
}

async function api(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: init?.method ?? "GET",
    headers: AUTH,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, data };
}

async function createDashboard(body: Record<string, unknown>) {
  const r = await api("/api/dashboards", { method: "POST", body });
  if (r.status === 200 && typeof r.data?.id === "number") {
    createdIds.push(r.data.id);
  }
  return r;
}

describe("composition dashboards CRUD", () => {
  let readableAreas: Array<{
    id: string;
    displayName: string;
    vendorType: string;
    legacySystemId: number;
  }> = [];

  beforeAll(async () => {
    const r = await api("/api/areas/readable");
    if (r.status === 200 && Array.isArray(r.data?.areas)) {
      readableAreas = r.data.areas;
    }
  });

  afterAll(async () => {
    // Best-effort cleanup of every row this suite created.
    for (const id of createdIds) {
      await api(`/api/dashboards/${id}`, { method: "DELETE" });
    }
  });

  it("creates a composition dashboard", async () => {
    const r = await createDashboard({ displayName: "IT create" });
    expect(r.status).toBe(200);
    expect(typeof r.data.id).toBe("number");
  });

  it("rejects a seedAreaId the caller cannot read (403)", async () => {
    const r = await createDashboard({
      displayName: "IT seed escalation",
      seedAreaId: "00000000-0000-0000-0000-000000000000",
    });
    expect(r.status).toBe(403);
  });

  it("returns 409 on an owner-unique alias collision", async () => {
    const alias = uniqueAlias();
    const first = await createDashboard({ displayName: "IT alias 1", alias });
    expect(first.status).toBe(200);
    const second = await createDashboard({ displayName: "IT alias 2", alias });
    expect(second.status).toBe(409);
  });

  it("renames a dashboard (PATCH displayName)", async () => {
    const created = await createDashboard({ displayName: "IT rename before" });
    expect(created.status).toBe(200);
    const id = created.data.id;
    const patched = await api(`/api/dashboards/${id}`, {
      method: "PATCH",
      body: { displayName: "IT rename after" },
    });
    expect(patched.status).toBe(200);
    const got = await api(`/api/dashboards/${id}`);
    expect(got.data.dashboard.displayName).toBe("IT rename after");
  });

  it("rejects a card bound to an unreadable Area (403)", async () => {
    const created = await createDashboard({ displayName: "IT escalation" });
    const id = created.data.id;
    const patched = await api(`/api/dashboards/${id}`, {
      method: "PATCH",
      body: {
        descriptor: {
          version: 2,
          layout: "site",
          cards: [
            {
              type: "chart",
              id: "x",
              areaId: "00000000-0000-0000-0000-000000000000",
            },
          ],
        },
      },
    });
    expect(patched.status).toBe(403);
  });

  it("keeps a sankey on a sidebar-vendor area (sankey works for any area with loads + sources)", async () => {
    const sidebarArea = readableAreas.find(
      (a) => a.vendorType !== "mondo" && a.vendorType !== "composite",
    );
    if (!sidebarArea) {
      console.warn(
        "no sidebar-vendor readable area; skipping sankey-keep assertion",
      );
      return;
    }
    const created = await createDashboard({ displayName: "IT sankey keep" });
    const id = created.data.id;
    // The sankey is no longer site-vendor-only: a v3 PATCH persists it on ANY readable area (the
    // data-driven renderer decides whether to draw it). It is NOT dropped.
    const patched = await api(`/api/dashboards/${id}`, {
      method: "PATCH",
      body: {
        descriptor: {
          version: 3,
          sections: [
            {
              areaId: sidebarArea.id,
              cards: [
                { type: "sankey", id: "keep-sankey" },
                {
                  type: "chart",
                  id: "keep-chart",
                  chart: { variant: "lines" },
                },
              ],
            },
          ],
        },
      },
    });
    expect(patched.status).toBe(200);
    const got = await api(`/api/dashboards/${id}`);
    const cards = got.data.dashboard.descriptor.sections.flatMap(
      (s: any) => s.cards,
    );
    const types = cards.map((c: any) => c.type);
    expect(types).toContain("sankey");
    expect(types).toContain("chart");
  });

  it("sets then unsets the default dashboard", async () => {
    const created = await createDashboard({ displayName: "IT default" });
    const id = created.data.id;

    const set = await api("/api/user/preferences", {
      method: "PATCH",
      body: { defaultDashboardId: id },
    });
    expect(set.status).toBe(200);
    const afterSet = await api("/api/user/preferences");
    expect(afterSet.data.preferences.defaultDashboardId).toBe(id);

    const unset = await api("/api/user/preferences", {
      method: "PATCH",
      body: { defaultDashboardId: null },
    });
    expect(unset.status).toBe(200);
    const afterUnset = await api("/api/user/preferences");
    expect(afterUnset.data.preferences.defaultDashboardId).toBeNull();
  });

  it("deletes a dashboard (then 404)", async () => {
    const created = await createDashboard({ displayName: "IT delete" });
    const id = created.data.id;
    const del = await api(`/api/dashboards/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const got = await api(`/api/dashboards/${id}`);
    expect(got.status).toBe(404);
  });
});
