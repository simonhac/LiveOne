import { auth, clerkClient } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import DashboardClient from "@/components/DashboardClient";
import HeatmapClient from "@/components/HeatmapClient";
import GeneratorClient from "@/components/GeneratorClient";
import AmberSync from "@/components/AmberSync";
import LatestReadingsClient from "@/components/LatestReadingsClient";
import DashboardLayout from "@/components/DashboardLayout";
import SharedDashboardView from "@/components/SharedDashboardView";
import { isUserAdmin } from "@/lib/auth-utils";
import { SystemsManager } from "@/lib/systems-manager";
import { VendorRegistry } from "@/lib/vendors/registry";
import { FLOW_MATRIX_SERVE_FROM_PG } from "@/lib/db/routing";
import { resolveGridContextForSystem } from "@/lib/grid/context";
import { hasEnabledTracker } from "@/lib/run-tracking/resolve";
import { validateDashboardShareToken } from "@/lib/dashboard/sharing";
import { getDashboardById } from "@/lib/dashboard/store";
import {
  getDashboard,
  getDashboardByOwnerAlias,
  type CompositionDashboard,
} from "@/lib/dashboard/dashboards";
import CompositionDashboardClient from "@/components/CompositionDashboardClient";
import { resolveAreasByIds } from "@/lib/areas/list";
import type { GridContext } from "@/lib/grid/types";
import type { DashboardDescriptor } from "@/lib/dashboard/descriptor";

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
 * Render a composition-first dashboard (Phase 2b-2). Resolves the NEM region server-side for each
 * Area that has a grid-signals card (region derives from the Area's location); other card types
 * self-resolve client-side.
 */
async function renderCompositionDashboard(
  dashboard: CompositionDashboard,
  canEdit: boolean,
) {
  const gridAreaIds = [
    ...new Set(
      dashboard.descriptor.cards
        .filter((c) => c.type === "grid-signals" && c.areaId)
        .map((c) => c.areaId as string),
    ),
  ];
  const gridContextByArea: Record<string, GridContext | null> = {};
  if (gridAreaIds.length > 0) {
    const areas = await resolveAreasByIds(gridAreaIds);
    await Promise.all(
      areas.map(async (a) => {
        gridContextByArea[a.id] = await resolveGridContextForSystem(
          a.legacySystemId,
        );
      }),
    );
  }
  return (
    <CompositionDashboardClient
      dashboard={{
        id: dashboard.id,
        displayName: dashboard.displayName,
        alias: dashboard.alias,
        descriptor: dashboard.descriptor,
      }}
      canEdit={canEdit}
      gridContextByArea={gridContextByArea}
      serveFlowFromPg={FLOW_MATRIX_SERVE_FROM_PG}
    />
  );
}

export default async function DashboardPage({
  params,
  searchParams,
}: PageProps) {
  const { userId } = await auth();
  const { slug } = await params;

  // P4 shared view: a valid `?access=` token renders the dashboard read-only, no sign-in. Resolve the
  // dashboard FROM the token (authoritative; the slug is cosmetic) so the queries hit the right system.
  // Invalid/expired tokens fall through to the normal authed flow.
  const sp = await searchParams;
  const accessToken = typeof sp?.access === "string" ? sp.access : undefined;
  if (accessToken) {
    const valid = await validateDashboardShareToken(accessToken);
    if (valid) {
      const dash = await getDashboardById(valid.dashboardId);
      // This legacy per-system shared view only renders home-system dashboards; a composition-first
      // dashboard (null system_id) flows through the new shared path instead.
      const sharedSystem =
        dash && dash.systemId != null
          ? await SystemsManager.getInstance().getSystem(dash.systemId)
          : null;
      if (
        dash &&
        dash.systemId != null &&
        sharedSystem &&
        sharedSystem.status !== "removed"
      ) {
        const descriptor = (dash.descriptor as DashboardDescriptor) ?? null;
        // Resolve the Areas this shared descriptor's cards reference (areaId→systemId+label) so the
        // read-only view can render + label multi-area cards without an authed /api/areas/readable
        // call. The share token authorizes each area's data fetch via the live union scope.
        const referencedAreaIds = [
          ...new Set(
            [
              dash.areaId,
              ...(descriptor?.cards ?? []).map((c) => c.areaId),
            ].filter((x): x is string => typeof x === "string"),
          ),
        ];
        const [gridContext, hasGenerator, sharedAreas] = await Promise.all([
          resolveGridContextForSystem(sharedSystem.id),
          hasEnabledTracker(sharedSystem.id, "generator"),
          resolveAreasByIds(referencedAreaIds),
        ]);
        return (
          <SharedDashboardView
            systemId={dash.systemId.toString()}
            system={sharedSystem}
            serveFlowFromPg={FLOW_MATRIX_SERVE_FROM_PG}
            gridContext={gridContext}
            hasGenerator={hasGenerator}
            sharedDescriptor={descriptor}
            sharedAreas={sharedAreas}
          />
        );
      }
    }
  }

  if (!userId) {
    redirect("/sign-in");
  }

  const isAdmin = await isUserAdmin();
  const systemsManager = SystemsManager.getInstance();

  const validSubPages = ["heatmap", "generator", "amber", "latest"] as const;

  // Composition-first dashboards (Phase 2b-2), addressed by id: `/dashboard/id/{id}` or
  // `/dashboard/{user}/id/{id}` (the {user} segment is cosmetic; access is by ownership/admin).
  const compositionId =
    slug.length === 2 && slug[0] === "id"
      ? slug[1]
      : slug.length === 3 && slug[1] === "id"
        ? slug[2]
        : null;
  if (compositionId && /^\d+$/.test(compositionId)) {
    const dashboard = await getDashboard(parseInt(compositionId, 10));
    if (!dashboard) redirect("/dashboard");
    const canEdit = dashboard.ownerClerkUserId === userId || isAdmin;
    if (!canEdit) redirect("/dashboard"); // sharing a composition dashboard arrives via ?access=
    return await renderCompositionDashboard(dashboard, canEdit);
  }

  // Pretty owner-scoped alias: `/dashboard/{user}/{shortname}`. Tried BEFORE the legacy system
  // username/alias route; a composition dashboard the caller can edit wins, otherwise fall through.
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
        return await renderCompositionDashboard(dash, true);
      }
    }
    // No matching composition dashboard → fall through to legacy system username/alias resolution.
  }

  // Check route type based on last segment
  const lastSegment = slug[slug.length - 1];
  const subPageRoute = validSubPages.includes(lastSegment as any)
    ? (lastSegment as (typeof validSubPages)[number])
    : null;

  let system = null;
  let systemId: string;
  let systemIdentifier: string | undefined;

  // Handle different URL patterns
  if (subPageRoute && slug.length === 2) {
    // Special route with numeric ID: /dashboard/1586/[heatmap|generator|amber]
    const segment = slug[0];
    const isNumericId = /^\d+$/.test(segment);

    if (isNumericId) {
      system = await systemsManager.getSystem(parseInt(segment));
      systemId = system?.id?.toString() || segment;
      systemIdentifier = segment;
    } else {
      redirect("/dashboard");
    }
  } else if (subPageRoute && slug.length === 3) {
    // Special route with username/alias: /dashboard/username/alias/[heatmap|generator|amber]
    const [username, alias] = slug;
    system = await systemsManager.getSystemByUsernameAndAlias(username, alias);
    systemId = system?.id?.toString() || `${username}/${alias}`;
    systemIdentifier = `${username}/${alias}`;
  } else if (slug.length === 1) {
    // Single segment: could be numeric ID or alias (legacy)
    const segment = slug[0];
    const isNumericId = /^\d+$/.test(segment);

    if (isNumericId) {
      // Numeric ID - look up and redirect to new format if it has an alias
      system = await systemsManager.getSystem(parseInt(segment));

      if (system?.alias && system.ownerClerkUserId) {
        // Canonicalise the URL to /dashboard/{owner-username}/{alias}. Guard the Clerk lookup:
        // the owner may be absent from THIS Clerk instance (the dev DB mirrors prod owner ids but
        // dev runs a different Clerk instance) or deleted in prod — in which case skip the
        // canonical redirect and render by numeric id rather than 500 the dashboard. redirect()
        // stays OUTSIDE the try so its internal control-flow throw isn't swallowed by the catch.
        let ownerUsername: string | null = null;
        try {
          const clerk = await clerkClient();
          const owner = await clerk.users.getUser(system.ownerClerkUserId);
          ownerUsername = owner.username;
        } catch {
          // Owner not found in this Clerk instance — fall through without redirecting.
        }
        if (ownerUsername) {
          redirect(`/dashboard/${ownerUsername}/${system.alias}`);
        }
      }

      systemId = system?.id?.toString() || segment;
    } else {
      // Non-numeric single segment - no longer supported
      redirect("/dashboard");
    }
  } else if (slug.length === 2 && !subPageRoute) {
    // Two segments: username/alias format
    const [username, alias] = slug;
    system = await systemsManager.getSystemByUsernameAndAlias(username, alias);
    systemId = system?.id?.toString() || `${username}/${alias}`;
  } else {
    // Invalid route
    redirect("/dashboard");
  }

  const systemExists = !!system;

  // Block access to removed systems (even for admins)
  if (system && system.status === "removed") {
    redirect("/dashboard");
  }

  // Check if user has access to this system
  let hasAccess = false;

  if (isAdmin) {
    // Admins have access to all systems that exist
    hasAccess = systemExists;
  } else if (system) {
    // Owner, or a public (ownerless) system — public systems are readable by everyone.
    hasAccess =
      system.ownerClerkUserId === userId || system.ownerClerkUserId == null;
  }

  // Fetch available systems for the user - only active systems
  const availableSystems = await systemsManager.getSystemsVisibleByUser(
    userId,
    true,
  ); // true = active only

  // Get current user's username for their own systems (enables username/shortname paths)
  const clerk = await clerkClient();
  const currentUser = await clerk.users.getUser(userId);
  const currentUsername = currentUser.username || null;

  // Add username to systems owned by current user
  const systemsWithUsernames = availableSystems.map((sys) => ({
    ...sys,
    ownerUsername: sys.ownerClerkUserId === userId ? currentUsername : null,
  }));

  // Render special routes based on last segment
  if (systemIdentifier && system && subPageRoute) {
    // Check access
    if (!hasAccess) {
      redirect("/dashboard");
    }

    switch (subPageRoute) {
      case "heatmap":
        return (
          <DashboardLayout
            system={system}
            userId={userId}
            isAdmin={isAdmin}
            availableSystems={systemsWithUsernames}
            supportsPolling={VendorRegistry.supportsPolling(system.vendorType)}
          >
            <HeatmapClient
              systemIdentifier={systemIdentifier}
              system={system}
              userId={userId}
              isAdmin={isAdmin}
              availableSystems={systemsWithUsernames}
            />
          </DashboardLayout>
        );
      case "generator":
        return (
          <DashboardLayout
            system={system}
            userId={userId}
            isAdmin={isAdmin}
            availableSystems={systemsWithUsernames}
            supportsPolling={VendorRegistry.supportsPolling(system.vendorType)}
          >
            <GeneratorClient
              systemIdentifier={systemIdentifier}
              system={system}
              userId={userId}
              isAdmin={isAdmin}
              availableSystems={systemsWithUsernames}
            />
          </DashboardLayout>
        );
      case "amber":
        // Only amber vendorTypes can access /amber subpage
        if (system.vendorType !== "amber") {
          const basePath =
            system.alias && currentUsername
              ? `/dashboard/${currentUsername}/${system.alias}`
              : `/dashboard/${system.id}`;
          redirect(basePath);
        }
        return (
          <DashboardLayout
            system={system}
            userId={userId}
            isAdmin={isAdmin}
            availableSystems={systemsWithUsernames}
            supportsPolling={VendorRegistry.supportsPolling(system.vendorType)}
          >
            <AmberSync
              systemIdentifier={systemIdentifier}
              system={system}
              userId={userId}
              isAdmin={isAdmin}
              availableSystems={systemsWithUsernames}
            />
          </DashboardLayout>
        );
      case "latest":
        return (
          <DashboardLayout
            system={system}
            userId={userId}
            isAdmin={isAdmin}
            availableSystems={systemsWithUsernames}
            supportsPolling={VendorRegistry.supportsPolling(system.vendorType)}
          >
            <LatestReadingsClient
              systemIdentifier={systemIdentifier}
              system={system}
              userId={userId}
              isAdmin={isAdmin}
              availableSystems={systemsWithUsernames}
            />
          </DashboardLayout>
        );
    }
  }

  // Resolve the "Local Grid (NEM)" card's cross-system context (the public OE region serving this
  // Area's location). Returns null when flags are off / off-grid / no derivable region. Only
  // resolved for an accessible system — an Access-Denied render never uses it, so skip the DB work.
  const gridContext =
    system && hasAccess ? await resolveGridContextForSystem(system.id) : null;

  // Whether to offer the generator-runs card (system has an enabled generator tracker).
  const hasGenerator = system
    ? await hasEnabledTracker(system.id, "generator")
    : false;

  // Render main dashboard
  if (!system) {
    return (
      <DashboardClient
        systemId={systemId}
        system={system}
        hasAccess={hasAccess}
        systemExists={systemExists}
        isAdmin={isAdmin}
        availableSystems={systemsWithUsernames}
        userId={userId}
        serveFlowFromPg={FLOW_MATRIX_SERVE_FROM_PG}
        gridContext={gridContext}
        hasGenerator={hasGenerator}
      />
    );
  }

  return (
    <DashboardLayout
      system={system}
      userId={userId}
      isAdmin={isAdmin}
      availableSystems={systemsWithUsernames}
      lastUpdate={null}
      systemInfo={null}
      supportsPolling={VendorRegistry.supportsPolling(system.vendorType)}
    >
      <DashboardClient
        systemId={systemId}
        system={system}
        hasAccess={hasAccess}
        systemExists={systemExists}
        isAdmin={isAdmin}
        availableSystems={systemsWithUsernames}
        userId={userId}
        serveFlowFromPg={FLOW_MATRIX_SERVE_FROM_PG}
        gridContext={gridContext}
        hasGenerator={hasGenerator}
      />
    </DashboardLayout>
  );
}
