import { auth, clerkClient } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { redirect, permanentRedirect } from "next/navigation";
import { isUserAdmin } from "@/lib/auth-utils";
import { validateDashboardShareToken } from "@/lib/dashboard/sharing";
import {
  getDashboard,
  getDashboardByOwnerAlias,
  getDashboardIdByLegacyId,
  listAccessibleDashboards,
  type CompositionDashboard,
} from "@/lib/dashboard/dashboards";
import DashboardClient from "@/components/DashboardClient";
import { getGrant } from "@/lib/dashboard/grants";
import { emptyDashboardV4, isDashboardV4 } from "@/lib/dashboard/v4";
import { listReadableAreas, resolveAreasByIds } from "@/lib/areas/list";
import { Area } from "@/lib/ids";
import { dashboardAreaUuids } from "@/lib/dashboard/composition";
import { getOrCreateUserPreferences } from "@/lib/user-preferences";
import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { getQueryClient } from "@/app/get-query-client";
import { queryKeys } from "@/lib/queries/keys";
import {
  MY_DASHBOARDS_KEY,
  USER_PREFERENCES_KEY,
  type MyDashboardsResponse,
} from "@/lib/queries";
import { getDeviceDataForCache } from "@/lib/dashboard/serve-data";
import { makeTimer, type ServerTimer } from "@/lib/server-timing";
import {
  listReadableDevices,
  resolveDevicesByIds,
  type ReadableDevice,
} from "@/lib/devices/list";
import { collectRefs } from "@/lib/dashboard/v4-validate";
import {
  CARD_HEIGHTS_COOKIE,
  parseCardHeights,
} from "@/lib/dashboard/card-heights";

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
 * Render a composition dashboard. The v4 document is opaque JSONB; every card/tile self-resolves
 * client-side against its Area's handle or a named member device (the `oe-grid` tile reads the OE
 * region member directly — no server-side region derivation).
 */
async function renderCompositionDashboard(
  dashboard: CompositionDashboard,
  canEdit: boolean,
  sharedAreas?: Awaited<ReturnType<typeof resolveAreasByIds>>,
  // Owner/admin authed view: the caller's full readable Areas, resolved server-side, so the client
  // skips the /api/v4/areas round-trip on load (SP1.1) while keeping the switcher + editor.
  initialReadableAreas?: Awaited<ReturnType<typeof listReadableAreas>>,
  // Optional SSR-render timer (server-timing instrumentation): times the `data` prefetch and, on
  // return, its `header()` (resolve + data + total) is surfaced inline as `#__ssr_timing` so the
  // Sydney perf harness can decompose the document TTFB. A Next page can't set response headers, so
  // the mirror rides in the DOM. See docs/performance/dashboard-fetch-waterfall.md.
  timer?: ServerTimer,
  // The signed-in viewer (owner/admin authed path). When present with no `sharedAreas`, the header
  // switcher's two queries are SSR-seeded (SP1.4). Omitted on the read-only shared (`?access=`) path.
  userId?: string | null,
) {
  // The v4 node tree is what renders (DashboardV4View, inside DashboardClient), and as of config-v4
  // Phase 14 stage 16 it is the ONLY shape: `descriptor` was made inert at stage 15 and dropped from
  // the database by migration 0054. `dashboards.doc` is NOT NULL (Phase 8/10 cutover) and its one write path validates it,
  // so this guard is a defence against a corrupt jsonb only — and a failed guard renders an EMPTY
  // document. That is deliberate: quietly serving a second, divergent shape from a shape-guard
  // failure is exactly the drift the cutover set out to end.
  const v4doc = isDashboardV4(dashboard.doc)
    ? dashboard.doc
    : emptyDashboardV4();
  const v4DeviceIds = collectRefs(v4doc).devices;
  const readableDevices: ReadableDevice[] =
    v4DeviceIds.length === 0
      ? []
      : sharedAreas
        ? await resolveDevicesByIds(v4DeviceIds)
        : dashboard.ownerClerkUserId
          ? (await listReadableDevices(dashboard.ownerClerkUserId)).filter(
              (d) => v4DeviceIds.includes(d.id),
            )
          : await resolveDevicesByIds(v4DeviceIds);
  const deviceById = new Map(readableDevices.map((d) => [d.id, d] as const));

  // SP1.2: SSR-prefetch each referenced device's /api/data (latest values) in-process and seed a
  // React Query HydrationBoundary, so cards render filled from cache instead of a client round-trip.
  // Handles come from the areas already resolved + authorized server-side (sharedAreas for a shared/
  // grantee view, initialReadableAreas for an owner) — we only prefetch devices the viewer may read.
  // Best-effort: a miss just means the card self-fetches, exactly as before.
  const areaById = new Map(
    (sharedAreas ?? initialReadableAreas ?? []).map((a) => [a.id, a] as const),
  );
  // Section handles (the whole-area devices).
  const handles = [
    ...new Set(
      dashboardAreaUuids(dashboard)
        .map((aid) => areaById.get(aid)?.legacySystemId)
        .filter((h): h is number => h != null),
    ),
  ];
  const queryClient = getQueryClient();
  // A tile/card can pin a specific device via `deviceSystemId` (e.g. the `oe-grid` tile → a public NEM
  // region device; a member device for `device-metrics`). Those pins are NOT section handles, so
  // without seeding they self-fetch /api/data on the client. Collect them from authorized sections.
  // config-v4 Phase 14 stage 15: the v3 walk that also collected `deviceSystemId` off descriptor
  // cards/tiles is gone. It was a duplicate, not a second source — `rewriteV3ToV4` carried every one
  // of those pins into the doc as a `dv_` device ref, which is exactly what `v4DeviceIds` below
  // resolves. Worst case it would only cost an SSR seed, since an unseeded pin self-fetches.
  const pins = new Set<number>();
  for (const id of v4DeviceIds) {
    const device = deviceById.get(id);
    if (device) pins.add(device.systemId);
  }
  const authorizedV4Pins = new Set(
    readableDevices.map((device) => device.systemId),
  );
  const prefetch = async () => {
    // SP1.2b: seed section handles (already authorized) unconditionally, plus device pins — but a pin
    // is seeded only if the payload we ALREADY fetch shows it's authorization-safe WITHOUT any extra
    // lookup: a public (owner-less) device, e.g. the oe-grid NEM region device, or one owned by the
    // viewer. `getDeviceDataForCache` does no per-viewer auth, so this owner check off the fetched
    // device is the guard. Anything else (a private pin we can't cheaply vouch for) falls through to
    // a client self-fetch, where /api/data enforces access — exactly as before. No re-derivation of
    // the pin from the opaque document, so no extra DB round-trips on the render's critical path.
    const pinIds = [...pins].filter((p) => !handles.includes(p));
    await Promise.all(
      [
        ...handles.map((id) => ({ id, isPin: false })),
        ...pinIds.map((id) => ({ id, isPin: true })),
      ].map(async ({ id, isPin }) => {
        try {
          const value = await getDeviceDataForCache(id);
          if (value == null) return;
          if (isPin) {
            // 🛑 Reads the DISCRIMINATED payload (config-v4 Phase 13 PR 1): `device` for a real
            // device, `area` for an Area. This is an AUTHORIZATION guard and `value` is `unknown`, so
            // the old `system` key would have compiled clean and silently read `undefined` — failing
            // closed (pins stop being seeded and self-fetch) but wrong.
            const subject = value as {
              device?: { ownerClerkUserId?: string | null };
              area?: { ownerClerkUserId?: string | null };
            };
            const owner = (subject.device ?? subject.area)?.ownerClerkUserId;
            const safe =
              authorizedV4Pins.has(id) ||
              owner === null ||
              (userId != null && owner === userId);
            if (!safe) return; // private pin we can't cheaply authorize → let the card self-fetch
          }
          queryClient.setQueryData(queryKeys.data(id), value);
        } catch {
          // best-effort prefetch — the card will self-fetch on the client
        }
      }),
    );
  };
  await (timer ? timer.time("data", prefetch) : prefetch());
  // 🛑 There is no `dataBatch` seed here any more. It wrote a SECOND copy of every payload above
  // into `queryKeys.dataBatch(handles)` for a `dashboardDataBatchQuery` that no component has ever
  // mounted — so it only ever doubled the dehydrated hydration JSON on a multi-area dashboard. The
  // query went with it; the per-id seeds below/above are what the cards actually read.

  // SP1.4: on the authed owner/admin path (the read-only shared view disables the switcher via
  // `enabled = !sharedAreas`), SSR-seed the header switcher's two queries — the user's dashboards
  // list + preferences — so DashboardsMenu paints without a client /api/v4/dashboards +
  // /api/user/preferences round-trip on load. Date fields → ISO strings to match the wire shape.
  if (!sharedAreas && userId) {
    const seedSwitcher = async () => {
      const [dashboardList, prefs] = await Promise.all([
        listAccessibleDashboards(userId),
        getOrCreateUserPreferences(userId),
      ]);
      // 🛑 This must emit `GET /api/v4/dashboards`' EXACT shape, not the DAO's. The seed and the fetch
      // write the same cache key, and `fetchJson<T>` is an unchecked cast — spreading the DAO row
      // (`displayName`/`alias`) under a DTO that says `name`/`slug` type-checks and paints every
      // switcher entry "Untitled" until the first refetch quietly replaces it.
      queryClient.setQueryData<MyDashboardsResponse>(MY_DASHBOARDS_KEY, {
        dashboards: dashboardList.map((d) => ({
          id: d.id,
          name: d.displayName,
          slug: d.alias,
          cardCount: d.cardCount,
          updatedAt: d.updatedAt.toISOString(),
          access: d.access,
        })),
      });
      queryClient.setQueryData(USER_PREFERENCES_KEY, {
        success: true,
        preferences: {
          clerkUserId: prefs.clerkUserId,
          defaultDashboardId: prefs.defaultDashboardId,
        },
      });
    };
    await (timer ? timer.time("switcher", seedSwitcher) : seedSwitcher());
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
            doc: v4doc,
            // The `If-Match` precondition for AddAreaDialog's whole-document PUT (§9.1). Sending the
            // revision the page actually rendered is what turns a concurrent edit into a 412 instead
            // of a lost update — so it must come from the same read as `doc`, not a second fetch.
            revision: dashboard.revision,
          }}
          canEdit={canEdit}
          // Heights this viewer's browser measured on a previous visit. Read HERE, in the RSC, so
          // the reservations land in the first painted frame — see lib/dashboard/card-heights.ts
          // for why this is a cookie and not localStorage.
          cardHeights={parseCardHeights(
            (await cookies()).get(CARD_HEIGHTS_COOKIE)?.value,
          )}
          // Encode ar_ at the wire boundary — sharedAreas/initialReadableAreas are raw-uuid
          // (below the seam) up to this point; the client's areaById must match the read-normalized
          // (ar_) document refs and the `ar_`-returning /api/v4/areas fetch fallback.
          sharedAreas={sharedAreas?.map((a) => ({
            ...a,
            id: Area.encode(a.id),
          }))}
          initialReadableAreas={initialReadableAreas?.map((a) => ({
            ...a,
            id: Area.encode(a.id),
          }))}
          resolvedDevices={readableDevices}
        />
      </HydrationBoundary>
    </>
  );
}

/**
 * `/dashboard/*` serves only composition (v3) dashboards now. Per-device "device" views live at
 * `/device/*`; any device-shaped slug here 301s there. A composition is shareable via `?access=`
 * (read-only, no sign-in); the legacy per-device share path is retired.
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
      // The token is authoritative; render the document read-only with the referenced Areas
      // resolved server-side, so each card's data fetch (token-authorized by the live union scope)
      // runs without an authed /api/v4/areas call.
      const composition = await timer.time("dashboard", () =>
        getDashboard(valid.dashboardId),
      );
      if (composition && composition.displayName) {
        const sharedAreas = await timer.time("areas", () =>
          resolveAreasByIds(dashboardAreaUuids(composition), {
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
  if (compositionId) {
    // config-v4: the legacy `/dashboard/id/{n}` (int) form redirects permanently to the opaque-id form
    // via dashboards.legacy_id → id; the primary address is the opaque `db_…` id (the DAO owns id↔uuid).
    if (/^\d+$/.test(compositionId)) {
      const dbId = await getDashboardIdByLegacyId(parseInt(compositionId, 10));
      if (!dbId) redirect("/dashboard");
      permanentRedirect(`/dashboard/id/${dbId}`);
    }
    const dashboard = await timer.time("dashboard", () =>
      getDashboard(compositionId),
    );
    if (!dashboard) redirect("/dashboard");
    const canEdit = dashboard.ownerClerkUserId === userId || isAdmin;
    // A signed-in non-owner with a grant views read-only; a true stranger is bounced (a public,
    // sign-in-free share still arrives via ?access=). Grantees get the document's Areas resolved
    // server-side (like the token path) so the client never calls the device-scoped /api/v4/areas.
    const grant = canEdit ? null : await getGrant(dashboard.id, userId);
    if (!canEdit && !grant) redirect("/dashboard");
    const sharedAreas = grant
      ? await resolveAreasByIds(dashboardAreaUuids(dashboard), {
          withChartCapability: true,
        })
      : undefined;
    // Owner/admin: SSR the caller's full readable-areas list so the client doesn't fire the
    // /api/v4/areas "chrome" request (SP1.1). Grantees already skip it via sharedAreas.
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
      userId,
    );
  }

  // Pretty owner-scoped alias: `/dashboard/{user}/{shortname}`. A composition dashboard the caller
  // can edit wins; otherwise it's a device-shaped slug → redirect to the device view.
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
          userId,
        );
      }
    }
    // No matching composition dashboard → fall through to the device redirect below.
  }

  // Everything else is a per-device "device" slug (numeric id, user/alias, or a sub-page). Devices
  // now live at /device/*; 301 there preserving the path shape.
  redirect(`/device/${slug.join("/")}`);
}
