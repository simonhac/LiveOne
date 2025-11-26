import { auth, clerkClient } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import DashboardClient from "@/components/DashboardClient";
import HeatmapClient from "@/components/HeatmapClient";
import GeneratorClient from "@/components/GeneratorClient";
import AmberSync from "@/components/AmberSync";
import LatestReadingsClient from "@/components/LatestReadingsClient";
import DashboardLayout from "@/components/DashboardLayout";
import { isUserAdmin } from "@/lib/auth-utils";
import { SystemsManager } from "@/lib/systems-manager";
import { VendorRegistry } from "@/lib/vendors/registry";

interface PageProps {
  params: Promise<{
    slug: string[];
  }>;
}

export default async function DashboardPage({ params }: PageProps) {
  const { userId } = await auth();
  const { slug } = await params;

  if (!userId) {
    redirect("/sign-in");
  }

  const isAdmin = await isUserAdmin();
  const systemsManager = SystemsManager.getInstance();

  // Check route type based on last segment
  const lastSegment = slug[slug.length - 1];
  const validSubPages = ["heatmap", "generator", "amber", "latest"] as const;
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
        const clerk = await clerkClient();
        const owner = await clerk.users.getUser(system.ownerClerkUserId);
        if (owner.username) {
          redirect(`/dashboard/${owner.username}/${system.alias}`);
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
    // Check if user owns this system
    hasAccess = system.ownerClerkUserId === userId;
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
      />
    </DashboardLayout>
  );
}
