import { auth, clerkClient } from "@clerk/nextjs/server";
// config-v4 slice K2: the page chrome still renders the three free-text spec strings, which are no
// longer columns — project them from `config.spec` at the prop boundary.
import { withSpecDisplayStrings } from "@/lib/capabilities/config";
import { redirect } from "next/navigation";
import DeviceViewer from "@/components/DeviceViewer";
import HeatmapClient from "@/components/HeatmapClient";
import GeneratorClient from "@/components/GeneratorClient";
import AmberSync from "@/components/AmberSync";
import LatestReadingsClient from "@/components/LatestReadingsClient";
import DeviceLayout from "@/components/DeviceLayout";
import { isUserAdmin } from "@/lib/auth-utils";
import { VendorRegistry } from "@/lib/vendors/registry";
import {
  buildDeviceStrategyDoc,
  type StrategyDeviceRef,
} from "@/lib/capabilities/server";
import { getUserIdByUsername } from "@/lib/user-cache";
import { resolveDefaultDashboardRoute } from "@/lib/user-preferences";
import { getViewerDevices } from "@/lib/devices/viewer-devices";
import { hasTimeTravelingCard } from "@/lib/dashboard/temporal-cards";
import type { DashboardV4 } from "@/lib/dashboard/v4";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";

interface PageProps {
  params: Promise<{
    slug: string[];
  }>;
}

/**
 * Per-device read-only viewer ("Device") at `/device/{id}` and the pretty `/device/{user}/{alias}`,
 * plus the per-device sub-pages `/device/{id}/{heatmap|generator|amber|latest}`. Renders the device's
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

  const validSubPages = ["heatmap", "generator", "amber", "latest"] as const;

  // Check route type based on last segment
  const lastSegment = slug[slug.length - 1];
  const subPageRoute = validSubPages.includes(lastSegment as any)
    ? (lastSegment as (typeof validSubPages)[number])
    : null;

  let device = null;
  let systemId: string;
  let systemIdentifier: string | undefined;

  // Handle different URL patterns
  if (subPageRoute && slug.length === 2) {
    // Special route with numeric ID: /device/1586/[heatmap|generator|amber|latest]
    const segment = slug[0];
    const isNumericId = /^\d+$/.test(segment);

    if (isNumericId) {
      device = await DeviceConfigRegistry.deviceByHandle(parseInt(segment));
      systemId = device?.id?.toString() || segment;
      systemIdentifier = segment;
    } else {
      redirect("/dashboard");
    }
  } else if (subPageRoute && slug.length === 3) {
    // Special route with username/alias: /device/username/alias/[heatmap|generator|amber|latest]
    const [username, alias] = slug;
    device = await DeviceConfigRegistry.deviceByUsernameAndSlug(
      username,
      alias,
    );
    systemId = device?.id?.toString() || `${username}/${alias}`;
    systemIdentifier = `${username}/${alias}`;
  } else if (slug.length === 1) {
    // Single segment: numeric ID
    const segment = slug[0];
    const isNumericId = /^\d+$/.test(segment);

    if (isNumericId) {
      // Numeric ID - look up and canonicalise to /device/{owner-username}/{alias} if it has an alias
      device = await DeviceConfigRegistry.deviceByHandle(parseInt(segment));

      if (device?.alias && device.ownerClerkUserId) {
        // Guard the Clerk lookup: the owner may be absent from THIS Clerk instance (dev mirrors prod
        // owner ids but runs a different Clerk instance) or deleted in prod — in which case skip the
        // canonical redirect and render by numeric id rather than 500. redirect() stays OUTSIDE the
        // try so its internal control-flow throw isn't swallowed by the catch.
        let ownerUsername: string | null = null;
        try {
          const clerk = await clerkClient();
          const owner = await clerk.users.getUser(device.ownerClerkUserId);
          ownerUsername = owner.username;
        } catch {
          // Owner not found in this Clerk instance — fall through without redirecting.
        }
        if (ownerUsername) {
          redirect(`/device/${ownerUsername}/${device.alias}`);
        }
      }

      systemId = device?.id?.toString() || segment;
    } else {
      // Non-numeric single segment: the `/device/{user}` browser landing. Resolve the username; if it's
      // the viewer (or an admin), land on that user's primary visible device — the persistent rail
      // (app/device/layout.tsx) shows the full list. Otherwise fall back to /dashboard (no exposure of
      // another user's device list; the rail always reflects the viewer's own devices anyway).
      const ownerId = await getUserIdByUsername(segment);
      if (ownerId && (ownerId === userId || isAdmin)) {
        const primary =
          await DeviceConfigRegistry.primaryVisibleDevice(ownerId);
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
    device = await DeviceConfigRegistry.deviceByUsernameAndSlug(
      username,
      alias,
    );
    systemId = device?.id?.toString() || `${username}/${alias}`;
  } else {
    // Invalid route
    redirect("/dashboard");
  }

  const deviceExists = !!device;

  // Block access to removed devices (even for admins)
  if (device && device.status === "removed") {
    redirect("/dashboard");
  }

  // Check if user has access to this device
  let hasAccess = false;

  if (isAdmin) {
    // Admins have access to all devices that exist
    hasAccess = deviceExists;
  } else if (device) {
    // Owner, or a public (ownerless) device — public devices are readable by everyone.
    hasAccess =
      device.ownerClerkUserId === userId || device.ownerClerkUserId == null;
  }

  // The viewer's visible devices (active only) + their username for pretty `/device/{user}/{alias}`
  // paths — shared (cache()d) with the rail layout so the query + Clerk lookup run once per request.
  const { devices: devicesWithUsernames, currentUsername } =
    await getViewerDevices(userId);

  // Render special routes based on last segment
  if (systemIdentifier && device && subPageRoute) {
    // Check access
    if (!hasAccess) {
      redirect("/dashboard");
    }

    switch (subPageRoute) {
      case "heatmap":
        return (
          <DeviceLayout
            device={withSpecDisplayStrings(device)}
            userId={userId}
            isAdmin={isAdmin}
            availableDevices={devicesWithUsernames}
            supportsPolling={VendorRegistry.supportsPolling(device.vendorType)}
          >
            <HeatmapClient
              systemIdentifier={systemIdentifier}
              device={device}
              userId={userId}
              isAdmin={isAdmin}
              availableDevices={devicesWithUsernames}
            />
          </DeviceLayout>
        );
      case "generator":
        return (
          <DeviceLayout
            device={withSpecDisplayStrings(device)}
            userId={userId}
            isAdmin={isAdmin}
            availableDevices={devicesWithUsernames}
            supportsPolling={VendorRegistry.supportsPolling(device.vendorType)}
          >
            <GeneratorClient
              systemIdentifier={systemIdentifier}
              device={device}
              userId={userId}
              isAdmin={isAdmin}
              availableDevices={devicesWithUsernames}
            />
          </DeviceLayout>
        );
      case "amber":
        // Only amber vendorTypes can access /amber subpage
        if (device.vendorType !== "amber") {
          const basePath =
            device.alias && currentUsername
              ? `/device/${currentUsername}/${device.alias}`
              : `/device/${device.id}`;
          redirect(basePath);
        }
        return (
          <DeviceLayout
            device={withSpecDisplayStrings(device)}
            userId={userId}
            isAdmin={isAdmin}
            availableDevices={devicesWithUsernames}
            supportsPolling={VendorRegistry.supportsPolling(device.vendorType)}
          >
            <AmberSync
              systemIdentifier={systemIdentifier}
              device={device}
              userId={userId}
              isAdmin={isAdmin}
              availableDevices={devicesWithUsernames}
            />
          </DeviceLayout>
        );
      case "latest":
        return (
          <DeviceLayout
            device={withSpecDisplayStrings(device)}
            userId={userId}
            isAdmin={isAdmin}
            availableDevices={devicesWithUsernames}
            supportsPolling={VendorRegistry.supportsPolling(device.vendorType)}
          >
            <LatestReadingsClient
              systemIdentifier={systemIdentifier}
              device={device}
              userId={userId}
              isAdmin={isAdmin}
              availableDevices={devicesWithUsernames}
            />
          </DeviceLayout>
        );
    }
  }

  // Server-build the device's default view from the same server/config capability path dashboards
  // use: `buildDeviceStrategyDoc` folds in grid context + generator tracking + config overrides.
  // config-v4 Phase 14 stage 9: it returns a v4 DOCUMENT bound to this DEVICE (§8.3) — the page is
  // device-scoped, so there is no area envelope and no synthetic `device-{id}` section id any more.
  // `devices` carries every `dv_` the doc binds (this device, plus the `oe-grid` pin when the area
  // has grid context) so the renderer can resolve them. Only for an accessible device; an
  // Access-Denied render never uses it.
  let doc: DashboardV4 | null = null;
  let resolvedDevices: StrategyDeviceRef[] = [];
  if (device && hasAccess) {
    const strategy = await buildDeviceStrategyDoc(device);
    doc = strategy.doc;
    resolvedDevices = strategy.devices;
  }

  // The single header temporal navigator: shown only when the device's default view hosts a
  // time-traveling component. Pure predicate over the same chartCapable the renderer gates on — the
  // doc binds no area, so chartCapable is unknown and the site charts (which also don't render here)
  // are excluded, exactly as before.
  const temporalNav =
    device && doc && hasTimeTravelingCard(doc, new Map())
      ? { handle: device.id, timezoneOffsetMin: device.timezoneOffsetMin }
      : null;

  // Render the device viewer. When the device doesn't exist, render without the chrome (the viewer
  // shows the Access-Denied state).
  if (!device) {
    return (
      <DeviceViewer
        systemId={systemId}
        device={device}
        hasAccess={hasAccess}
        deviceExists={deviceExists}
        isAdmin={isAdmin}
        userId={userId}
        doc={doc}
        resolvedDevices={resolvedDevices}
      />
    );
  }

  return (
    <DeviceLayout
      device={withSpecDisplayStrings(device)}
      userId={userId}
      isAdmin={isAdmin}
      availableDevices={devicesWithUsernames}
      lastUpdate={null}
      deviceInfo={null}
      supportsPolling={VendorRegistry.supportsPolling(device.vendorType)}
      temporalNav={temporalNav}
    >
      <DeviceViewer
        systemId={systemId}
        device={device}
        hasAccess={hasAccess}
        deviceExists={deviceExists}
        isAdmin={isAdmin}
        userId={userId}
        doc={doc}
        resolvedDevices={resolvedDevices}
      />
    </DeviceLayout>
  );
}
