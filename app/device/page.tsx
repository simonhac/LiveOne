import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { resolveDefaultDashboardRoute } from "@/lib/user-preferences";
import { DeviceConfigRegistry } from "@/lib/registry/device-config";

/**
 * "Go to Devices" target from the dashboards switcher: jump straight to the first device/device the
 * user can see, deliberately SKIPPING the default-dashboard redirect that `/dashboard` does first.
 * Mirrors `/dashboard`'s primary resolution via the shared `getPrimaryVisibleDevice` helper. With no
 * visible devices, fall back to the user's default dashboard so a dashboards-only user isn't dumped
 * on the headerless "No Devices Found" page. `/device` has no index segment, so this owns it cleanly
 * (the `[...slug]` catch-all only matches `/device/{…}`).
 */
export default async function DeviceIndexPage() {
  const { userId } = await auth();
  if (!userId) {
    redirect("/sign-in");
  }

  const primary = await DeviceConfigRegistry.primaryVisibleDevice(userId);
  if (primary) {
    redirect(`/device/${primary.id}`);
  }

  redirect((await resolveDefaultDashboardRoute(userId)) ?? "/dashboard");
}
