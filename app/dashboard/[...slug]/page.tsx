import { auth, clerkClient } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { isUserAdmin } from "@/lib/auth-utils";
import { validateDashboardShareToken } from "@/lib/dashboard/sharing";
import {
  getDashboard,
  getDashboardByOwnerAlias,
  type CompositionDashboard,
} from "@/lib/dashboard/dashboards";
import DashboardClient from "@/components/DashboardClient";
import { getGrant } from "@/lib/dashboard/grants";
import { isDashboardV3, type DashboardV3 } from "@/lib/dashboard/v3";
import { listReadableAreas, resolveAreasByIds } from "@/lib/areas/list";
import { descriptorAreaIds } from "@/lib/dashboard/composition";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { getQueryClient } from "@/app/get-query-client";
import { queryKeys } from "@/lib/queries/keys";
import { getSystemDataForCache } from "@/lib/dashboard/serve-data";
import { makeTimer, type ServerTimer } from "@/lib/server-timing";

interface PageProps {
  params: Promise<{
    slug: string[];
  }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

/** Resolve a Clerk username → its user id (for `/dashboard/{user}/{shortname}`). Null if none. */
async function resolveClerkUserIdByUsername(
  username: string,
): Promise<string | null> {
  try {
    const clerk = await clerkClient();
    const res = await clerk.users.getUserList({
      username: [username],
      limit: 1,
    });
    return res.data[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Render a nested (v3) dashboard. The descriptor is opaque JSONB; every card/tile self-resolves
 * client-side against its Area's handle or a named member device (the `oe-grid` tile reads the OE
 * region member directly — no server-side region derivation).
 */
async function renderCompositionDashboard(
  dashboard: CompositionDashboard,
  canEdit: boolean,
  sharedAreas?: Awaited<ReturnType<typeof resolveAreasByIds>>,
  // Owner/admin authed view: the caller's full readable Areas, resolved server-side, so the client
  // skips the /api/areas/readable round-trip on load (SP1.1) while keeping the switcher + editor.
  initialReadableAreas?: Awaited<ReturnType<typeof listReadableAreas>>,
  // Optional SSR-render timer (server-timing instrumentation): times the `data` prefetch and, on
  // return, its `header()` (resolve + data + total) is surfaced inline as `#__ssr_timing` so the
  // Sydney perf harness can decompose the document TTFB. A Next page can't set response headers, so
  // the mirror rides in the DOM. See docs/performance/dashboard-fetch-waterfall.md.
  timer?: ServerTimer,
) {
  const raw: unknown = dashboard.descriptor;
  const descriptor: DashboardV3 = isDashboardV3(raw)
    ? raw
    : { version: 3, sections: [] };

  // SP1.2: SSR-prefetch each referenced system's /api/data (latest values) in-process and seed a
  // React Query HydrationBoundary, so cards render filled from cache instead of a client round-trip.
  // Handles come from the areas already resolved + authorized server-side (sharedAreas for a shared/
  // grantee view, initialReadableAreas for an owner) — we only prefetch systems the viewer may read.
  // Best-effort: a miss just means the card self-fetches, exactly as before.
  const areaById = new Map(
    (sharedAreas ?? initialReadableAreas ?? []).map((a) => [a.id, a] as const),
  );
  const handles = [
    ...new Set(
      descriptorAreaIds(raw)
        .map((aid) => areaById.get(aid)?.legacySystemId)
        .filter((h): h is number => h != null),
    ),
  ];
  const queryClient = getQueryClient();
  const seeded: Record<string, unknown> = {};
  const prefetch = () =>
    Promise.all(
      handles.map(async (h) => {
        try {
          const value = await getSystemDataForCache(h);
          if (value != null) {
            queryClient.setQueryData(queryKeys.data(h), value);
            seeded[String(h)] = value;
          }
        } catch {
          // best-effort prefetch — the card will self-fetch on the client
        }
      }),
    );
  await (timer ? timer.time("data", prefetch) : prefetch());
  // A multi-system dashboard also runs dashboardDataBatchQuery(handles); seed its key (the same
  // sorted string-id set the client derives) so it doesn't refetch despite warm per-system caches.
  const batchIds = [...new Set(handles.map(String))].sort();
  if (batchIds.length > 1) {
    queryClient.setQueryData(queryKeys.dataBatch(batchIds), seeded);
  }

  return (
    <>
      {timer ? (
        // Inline mirror of the SSR-render Server-Timing (a Next page can't set response headers).
        // Read by the Sydney perf harness via document.getElementById('__ssr_timing'); inert JSON.
        <script
          id="__ssr_timing"
          type="application/json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(timer.header()) }}
        />
      ) : null}
      <HydrationBoundary state={dehydrate(queryClient)}>
        <DashboardClient
          dashboard={{
            id: dashboard.id,
            displayName: dashboard.displayName,
            alias: dashboard.alias,
            descriptor,
          }}
          canEdit={canEdit}
          sharedAreas={sharedAreas}
          initialReadableAreas={initialReadableAreas}
        />
      </HydrationBoundary>
    </>
  );
}

/**
 * `/dashboard/*` serves only composition (v3) dashboards now. Per-system "device" views live at
 * `/device/*`; any system-shaped slug here 301s there. A composition is shareable via `?access=`
 * (read-only, no sign-in); the legacy per-system share path is retired.
 */
export default async function DashboardPage({
  params,
  searchParams,
}: PageProps) {
  // Time the SSR render's server-side phases (auth / token / dashboard / areas / data prefetch) so
  // the Sydney perf harness can decompose the document TTFB. Surfaced inline in the rendered HTML by
  // renderCompositionDashboard (a Next page can't set response headers).
  const timer = makeTimer();
  const { userId } = await timer.time("auth", () => auth());
  const { slug } = await params;

  // Shared view: a valid `?access=` token renders the composition dashboard read-only, no sign-in.
  // Resolve the dashboard FROM the token (authoritative; the slug is cosmetic). Invalid/expired
  // tokens fall through to the normal authed flow.
  const sp = await searchParams;
  const accessToken = typeof sp?.access === "string" ? sp.access : undefined;
  if (accessToken) {
    const valid = await timer.time("token", () =>
      validateDashboardShareToken(accessToken),
    );
    if (valid) {
      // The token is authoritative; render the v3 descriptor read-only with the referenced Areas
      // resolved server-side, so each card's data fetch (token-authorized by the live union scope)
      // runs without an authed /api/areas/readable call.
      const composition = await timer.time("dashboard", () =>
        getDashboard(valid.dashboardId),
      );
      if (composition && composition.displayName) {
        const sharedAreas = await timer.time("areas", () =>
          resolveAreasByIds(descriptorAreaIds(composition.descriptor), {
            withChartCapability: true,
          }),
        );
        return await renderCompositionDashboard(
          composition,
          false,
          sharedAreas,
          undefined,
          timer,
        );
      }
    }
  }

  if (!userId) {
    redirect("/sign-in");
  }

  const isAdmin = await timer.time("admin", () => isUserAdmin());

  const validSubPages = ["heatmap", "generator", "amber", "latest"] as const;

  // Composition dashboards (Phase 2b-2), addressed by id: `/dashboard/id/{id}` or
  // `/dashboard/{user}/id/{id}` (the {user} segment is cosmetic; access is by ownership/admin).
  const compositionId =
    slug.length === 2 && slug[0] === "id"
      ? slug[1]
      : slug.length === 3 && slug[1] === "id"
        ? slug[2]
        : null;
  if (compositionId && /^\d+$/.test(compositionId)) {
    const dashboard = await timer.time("dashboard", () =>
      getDashboard(parseInt(compositionId, 10)),
    );
    if (!dashboard) redirect("/dashboard");
    const canEdit = dashboard.ownerClerkUserId === userId || isAdmin;
    // A signed-in non-owner with a grant views read-only; a true stranger is bounced (a public,
    // sign-in-free share still arrives via ?access=). Grantees get the descriptor's Areas resolved
    // server-side (like the token path) so the client never calls the system-scoped /api/areas/readable.
    const grant = canEdit ? null : await getGrant(dashboard.id, userId);
    if (!canEdit && !grant) redirect("/dashboard");
    const sharedAreas = grant
      ? await resolveAreasByIds(descriptorAreaIds(dashboard.descriptor), {
          withChartCapability: true,
        })
      : undefined;
    // Owner/admin: SSR the caller's full readable-areas list so the client doesn't fire the
    // /api/areas/readable "chrome" request (SP1.1). Grantees already skip it via sharedAreas.
    const initialReadableAreas = canEdit
      ? await timer.time("areas", () =>
          listReadableAreas(userId, { withChartCapability: true }),
        )
      : undefined;
    return await renderCompositionDashboard(
      dashboard,
      canEdit,
      sharedAreas,
      initialReadableAreas,
      timer,
    );
  }

  // Pretty owner-scoped alias: `/dashboard/{user}/{shortname}`. A composition dashboard the caller
  // can edit wins; otherwise it's a system-shaped slug → redirect to the device view.
  if (
    slug.length === 2 &&
    !/^\d+$/.test(slug[0]) &&
    slug[0] !== "id" &&
    slug[1] !== "id" &&
    !validSubPages.includes(slug[1] as (typeof validSubPages)[number])
  ) {
    const ownerId = await resolveClerkUserIdByUsername(slug[0]);
    if (ownerId) {
      const dash = await getDashboardByOwnerAlias(ownerId, slug[1]);
      if (dash && (dash.ownerClerkUserId === userId || isAdmin)) {
        const initialReadableAreas = await timer.time("areas", () =>
          listReadableAreas(userId, { withChartCapability: true }),
        );
        return await renderCompositionDashboard(
          dash,
          true,
          undefined,
          initialReadableAreas,
          timer,
        );
      }
    }
    // No matching composition dashboard → fall through to the device redirect below.
  }

  // Everything else is a per-system "device" slug (numeric id, user/alias, or a sub-page). Devices
  // now live at /device/*; 301 there preserving the path shape.
  redirect(`/device/${slug.join("/")}`);
}
