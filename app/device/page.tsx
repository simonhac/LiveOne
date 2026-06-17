import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { SystemsManager } from "@/lib/systems-manager";
import { resolveDefaultDashboardRoute } from "@/lib/user-preferences";

/**
 * "Go to Devices" target from the dashboards switcher: jump straight to the first system/device the
 * user can see, deliberately SKIPPING the default-dashboard redirect that `/dashboard` does first.
 * Mirrors `/dashboard`'s primary resolution via the shared `getPrimaryVisibleSystem` helper. With no
 * visible systems, fall back to the user's default dashboard so a dashboards-only user isn't dumped
 * on the headerless "No Systems Found" page. `/device` has no index segment, so this owns it cleanly
 * (the `[...slug]` catch-all only matches `/device/{…}`).
 */
export default async function DeviceIndexPage() {
  const { userId } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }

  const primary =
    await SystemsManager.getInstance().getPrimaryVisibleSystem(userId);
  if (primary) {
    redirect(`/device/${primary.id}`);
  }

  redirect((await resolveDefaultDashboardRoute(userId)) ?? "/dashboard");
}
