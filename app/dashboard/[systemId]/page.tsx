import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import DashboardClient from "@/components/DashboardClient";
import { isUserAdmin } from "@/lib/auth-utils";
import { SystemsManager } from "@/lib/systems-manager";
import { VendorRegistry } from "@/lib/vendors/registry";

interface PageProps {
  params: Promise<{
    systemId: string;
  }>;
}

export default async function DashboardSystemPage({ params }: PageProps) {
  const { userId } = await auth();
  const { systemId } = await params;

  if (!userId) {
    redirect("/sign-in");
  }

  const isAdmin = await isUserAdmin();

  // Get systems manager instance
  const systemsManager = SystemsManager.getInstance();

  // Determine if systemId is numeric (ID) or alphanumeric (shortname)
  const isNumericId = /^\d+$/.test(systemId);

  let system;
  if (isNumericId) {
    // Look up by ID
    system = await systemsManager.getSystem(parseInt(systemId));

    // If system has a shortname, redirect to shortname URL
    if (system?.shortName) {
      redirect(`/dashboard/${system.shortName}`);
    }
  } else {
    // Look up by shortname
    system = await systemsManager.getSystemByShortName(systemId);
  }

  const systemExists = !!system;

  // Debug logging for admin access
  // if (isAdmin) {
  //   console.log('[Dashboard] Admin access check:', {
  //     userId,
  //     systemId,
  //     systemExists,
  //     systemOwner: system?.ownerClerkUserId,
  //     isAdmin
  //   })
  // }

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

  // Get the dataStore type for this system's vendor (only if system exists)
  const dataStore = system
    ? VendorRegistry.getDataStore(system.vendorType)
    : undefined;

  return (
    <DashboardClient
      systemId={system?.id?.toString() || systemId}
      system={system}
      hasAccess={hasAccess}
      systemExists={systemExists}
      isAdmin={isAdmin}
      availableSystems={availableSystems}
      userId={userId}
      dataStore={dataStore}
    />
  );
}
