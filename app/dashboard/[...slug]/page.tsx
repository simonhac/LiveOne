import { auth, clerkClient } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import DashboardClient from "@/components/DashboardClient";
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

  let system = null;
  let systemId: string;

  // Handle different URL patterns
  if (slug.length === 1) {
    // Single segment: could be numeric ID or shortname (legacy)
    const segment = slug[0];
    const isNumericId = /^\d+$/.test(segment);

    if (isNumericId) {
      // Numeric ID - look up and redirect to new format if it has a shortname
      system = await systemsManager.getSystem(parseInt(segment));

      if (system?.shortName && system.ownerClerkUserId) {
        const clerk = await clerkClient();
        const owner = await clerk.users.getUser(system.ownerClerkUserId);
        if (owner.username) {
          redirect(`/dashboard/${owner.username}/${system.shortName}`);
        }
      }

      systemId = system?.id?.toString() || segment;
    } else {
      // Non-numeric single segment - no longer supported
      redirect("/dashboard");
    }
  } else if (slug.length === 2) {
    // Two segments: username/shortname format
    const [username, shortname] = slug;
    system = await systemsManager.getSystemByUserNameShortName(
      username,
      shortname,
    );
    systemId = system?.id?.toString() || `${username}/${shortname}`;
  } else {
    // More than 2 segments - invalid
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

  // Get the dataStore type for this system's vendor (only if system exists)
  const dataStore = system
    ? VendorRegistry.getDataStore(system.vendorType)
    : undefined;

  return (
    <DashboardClient
      systemId={systemId}
      system={system}
      hasAccess={hasAccess}
      systemExists={systemExists}
      isAdmin={isAdmin}
      availableSystems={systemsWithUsernames}
      userId={userId}
      dataStore={dataStore}
    />
  );
}
