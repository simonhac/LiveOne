import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { SystemsManager } from "@/lib/systems-manager";
import { resolveDefaultDashboardRoute } from "@/lib/user-preferences";

export default async function DashboardPage() {
  const { userId } = await auth();

  if (!userId) {
    redirect("/sign-in");
  }

  // Redirect to the user's saved default FIRST — a composition dashboard (`/dashboard/id/{id}`) needs
  // no visible system, so this must run before the "No Systems Found" guard below. Validated +
  // auto-cleared inside; a deleted/inaccessible default returns null and we fall through.
  const defaultRoute = await resolveDefaultDashboardRoute(userId);
  if (defaultRoute) {
    redirect(defaultRoute);
  }

  const systemsManager = SystemsManager.getInstance();

  // Get all systems visible to the user (owned + granted access)
  const visibleSystems = await systemsManager.getSystemsVisibleByUser(
    userId,
    true,
  );

  if (visibleSystems.length === 0) {
    // No default dashboard and no visible systems → nothing to show.
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center max-w-md">
          <h2 className="text-xl font-semibold text-white mb-2">
            No Systems Found
          </h2>
          <p className="text-gray-400">
            You don&apos;t have access to any systems. Please contact your
            system administrator.
          </p>
        </div>
      </div>
    );
  }

  // Fallback: prioritize user-owned systems over first viewable system
  const ownedSystems = visibleSystems.filter(
    (s) => s.ownerClerkUserId === userId,
  );
  const primarySystem =
    ownedSystems.length > 0 ? ownedSystems[0] : visibleSystems[0];

  redirect(`/device/${primarySystem.id}`);
}
