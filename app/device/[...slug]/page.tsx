import { auth, clerkClient } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import DeviceViewer from "@/components/DeviceViewer";
import HeatmapClient from "@/components/HeatmapClient";
import GeneratorClient from "@/components/GeneratorClient";
import AmberSync from "@/components/AmberSync";
import LatestReadingsClient from "@/components/LatestReadingsClient";
import DeviceLayout from "@/components/DeviceLayout";
import { isUserAdmin } from "@/lib/auth-utils";
import { SystemsManager } from "@/lib/systems-manager";
import { VendorRegistry } from "@/lib/vendors/registry";
import { resolveGridContextForSystem } from "@/lib/grid/context";
import { hasEnabledTracker } from "@/lib/run-tracking/resolve";
import { getUserIdByUsername } from "@/lib/user-cache";
import { resolveDefaultDashboardRoute } from "@/lib/user-preferences";
import { getViewerDevices } from "@/lib/devices/viewer-devices";

interface PageProps {
  params: Promise<{
    slug: string[];
  }>;
}

/**
 * Per-system read-only viewer ("Device") at `/device/{id}` and the pretty `/device/{user}/{alias}`,
 * plus the per-system sub-pages `/device/{id}/{heatmap|generator|amber|latest}`. Renders the system's
 * DEFAULT layout — no Customise / Share / New-dashboard (those live on composition Dashboards at
 * `/dashboard/id/{id}`). A device is NOT shareable: there is no `?access=` token path here.
 */
export default async function DevicePage({ params }: PageProps) {
  const { userId } = await auth();
  const { slug } = await params;

  if (!userId) {
    redirect("/sign-in");
  }

  const isAdmin = await isUserAdmin();
  const systemsManager = SystemsManager.getInstance();

  const validSubPages = ["heatmap", "generator", "amber", "latest"] as const;

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
    // Special route with numeric ID: /device/1586/[heatmap|generator|amber|latest]
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
    // Special route with username/alias: /device/username/alias/[heatmap|generator|amber|latest]
    const [username, alias] = slug;
    system = await systemsManager.getSystemByUsernameAndAlias(username, alias);
    systemId = system?.id?.toString() || `${username}/${alias}`;
    systemIdentifier = `${username}/${alias}`;
  } else if (slug.length === 1) {
    // Single segment: numeric ID
    const segment = slug[0];
    const isNumericId = /^\d+$/.test(segment);

    if (isNumericId) {
      // Numeric ID - look up and canonicalise to /device/{owner-username}/{alias} if it has an alias
      system = await systemsManager.getSystem(parseInt(segment));

      if (system?.alias && system.ownerClerkUserId) {
        // Guard the Clerk lookup: the owner may be absent from THIS Clerk instance (dev mirrors prod
        // owner ids but runs a different Clerk instance) or deleted in prod — in which case skip the
        // canonical redirect and render by numeric id rather than 500. redirect() stays OUTSIDE the
        // try so its internal control-flow throw isn't swallowed by the catch.
        let ownerUsername: string | null = null;
        try {
          const clerk = await clerkClient();
          const owner = await clerk.users.getUser(system.ownerClerkUserId);
          ownerUsername = owner.username;
        } catch {
          // Owner not found in this Clerk instance — fall through without redirecting.
        }
        if (ownerUsername) {
          redirect(`/device/${ownerUsername}/${system.alias}`);
        }
      }

      systemId = system?.id?.toString() || segment;
    } else {
      // Non-numeric single segment: the `/device/{user}` browser landing. Resolve the username; if it's
      // the viewer (or an admin), land on that user's primary visible device — the persistent rail
      // (app/device/layout.tsx) shows the full list. Otherwise fall back to /dashboard (no exposure of
      // another user's device list; the rail always reflects the viewer's own devices anyway).
      const ownerId = await getUserIdByUsername(segment);
      if (ownerId && (ownerId === userId || isAdmin)) {
        const primary = await systemsManager.getPrimaryVisibleSystem(ownerId);
        if (primary) {
          redirect(`/device/${primary.id}`);
        }
        redirect((await resolveDefaultDashboardRoute(ownerId)) ?? "/dashboard");
      }
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

  // The viewer's visible devices (active only) + their username for pretty `/device/{user}/{alias}`
  // paths — shared (cache()d) with the rail layout so the query + Clerk lookup run once per request.
  const { systems: systemsWithUsernames, currentUsername } =
    await getViewerDevices(userId);

  // Render special routes based on last segment
  if (systemIdentifier && system && subPageRoute) {
    // Check access
    if (!hasAccess) {
      redirect("/dashboard");
    }

    switch (subPageRoute) {
      case "heatmap":
        return (
          <DeviceLayout
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
          </DeviceLayout>
        );
      case "generator":
        return (
          <DeviceLayout
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
          </DeviceLayout>
        );
      case "amber":
        // Only amber vendorTypes can access /amber subpage
        if (system.vendorType !== "amber") {
          const basePath =
            system.alias && currentUsername
              ? `/device/${currentUsername}/${system.alias}`
              : `/device/${system.id}`;
          redirect(basePath);
        }
        return (
          <DeviceLayout
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
          </DeviceLayout>
        );
      case "latest":
        return (
          <DeviceLayout
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
          </DeviceLayout>
        );
    }
  }

  // Resolve the "Local Grid (NEM)" card's cross-system context (the public OE region serving this
  // device's location). Returns null when flags are off / off-grid / no derivable region. Only
  // resolved for an accessible system — an Access-Denied render never uses it, so skip the DB work.
  const gridContext =
    system && hasAccess ? await resolveGridContextForSystem(system.id) : null;

  // Whether to offer the generator-runs card (system has an enabled generator tracker).
  const hasGenerator = system
    ? await hasEnabledTracker(system.id, "generator")
    : false;

  // Render the device viewer. When the system doesn't exist, render without the chrome (the viewer
  // shows the Access-Denied state).
  if (!system) {
    return (
      <DeviceViewer
        systemId={systemId}
        system={system}
        hasAccess={hasAccess}
        systemExists={systemExists}
        isAdmin={isAdmin}
        userId={userId}
        gridContext={gridContext}
        hasGenerator={hasGenerator}
      />
    );
  }

  return (
    <DeviceLayout
      system={system}
      userId={userId}
      isAdmin={isAdmin}
      availableSystems={systemsWithUsernames}
      lastUpdate={null}
      systemInfo={null}
      supportsPolling={VendorRegistry.supportsPolling(system.vendorType)}
    >
      <DeviceViewer
        systemId={systemId}
        system={system}
        hasAccess={hasAccess}
        systemExists={systemExists}
        isAdmin={isAdmin}
        userId={userId}
        gridContext={gridContext}
        hasGenerator={hasGenerator}
      />
    </DeviceLayout>
  );
}
