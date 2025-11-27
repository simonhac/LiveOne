import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { SystemsManager } from "@/lib/systems-manager";
import { getValidDefaultSystemId } from "@/lib/user-preferences";

export default async function DashboardPage() {
  const { userId } = await auth();

  if (!userId) {
    redirect("/sign-in");
  }

  const systemsManager = SystemsManager.getInstance();

  // Get all systems visible to the user (owned + granted access)
  const visibleSystems = await systemsManager.getSystemsVisibleByUser(
    userId,
    true,
  );

  if (visibleSystems.length === 0) {
    // No systems found for this user
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

  // Check for user's saved default system
  const defaultSystemId = await getValidDefaultSystemId(userId);
  if (defaultSystemId) {
    // Verify the default system is in the visible systems list
    const defaultSystem = visibleSystems.find((s) => s.id === defaultSystemId);
    if (defaultSystem) {
      redirect(`/dashboard/${defaultSystem.id}`);
    }
  }

  // Fallback: prioritize user-owned systems over first viewable system
  const ownedSystems = visibleSystems.filter(
    (s) => s.ownerClerkUserId === userId,
  );
  const primarySystem =
    ownedSystems.length > 0 ? ownedSystems[0] : visibleSystems[0];

  redirect(`/dashboard/${primarySystem.id}`);
}
