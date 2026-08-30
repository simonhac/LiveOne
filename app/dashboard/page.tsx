import { auth, clerkClient } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { resolveDefaultDashboardRoute } from "@/lib/user-preferences";
import { listAccessibleDashboards } from "@/lib/dashboard/dashboards";
import { dashboardHref } from "@/lib/dashboard/href";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";

export default async function DashboardPage() {
  const { userId } = await auth();

  if (!userId) {
    redirect("/sign-in");
  }

  // 1) The user's saved default, if any (a composition dashboard → its canonical URL, or a
  //    per-device default → `/device/{id}`). Validated + auto-cleared inside; null → fall through.
  const defaultRoute = await resolveDefaultDashboardRoute(userId);
  if (defaultRoute) {
    redirect(defaultRoute);
  }

  // 2) No default → the first dashboard they can reach (owned ∪ shared) alphabetically by label.
  const accessible = await listAccessibleDashboards(userId);
  if (accessible.length > 0) {
    const first = [...accessible].sort((a, b) =>
      (a.displayName ?? "").localeCompare(b.displayName ?? "", undefined, {
        sensitivity: "base",
      }),
    )[0];
    // Pretty URL when it's the user's own slugged dashboard (granted rows keep the id form — we
    // don't hold the other owner's username here); null/failed username → id form.
    let ownerUsername: string | null = null;
    if (first.alias && first.access === "owner") {
      try {
        const clerk = await clerkClient();
        ownerUsername = (await clerk.users.getUser(userId)).username ?? null;
      } catch {
        ownerUsername = null;
      }
    }
    redirect(dashboardHref({ id: first.id, slug: first.alias, ownerUsername }));
  }

  // 3) No default and no dashboards → a friendly empty state. Offer "Browse devices" when the user
  //    still has a visible device, so a device-only viewer isn't stranded here.
  const primaryDevice = await DeviceConfigRegistry.primaryVisibleDevice(userId);

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center">
      <div className="text-center max-w-md">
        <h2 className="text-xl font-semibold text-white mb-2">No dashboards</h2>
        <p className="text-gray-400">
          You don&apos;t have any dashboards yet, and none have been shared with
          you.
        </p>
        {primaryDevice && (
          <Link
            href={`/device/${primaryDevice.id}`}
            className="mt-4 inline-block rounded-md bg-blue-600 px-4 py-2 text-sm text-white transition-colors hover:bg-blue-700"
          >
            Browse devices
          </Link>
        )}
      </div>
    </div>
  );
}
