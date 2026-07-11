import { Suspense, type ReactNode } from "react";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import DeviceRail from "@/components/DeviceRail";
import { getViewerDevices } from "@/lib/devices/viewer-devices";

/**
 * Shared shell for every `/device/*` route: a persistent left rail listing the viewer's devices beside
 * the page content. App Router keeps a shared layout mounted across sibling navigations, so the rail is
 * fetched once and does NOT re-render when you click between devices — clicking a rail row swaps only
 * `{children}` (the device page, server-rendered with its own per-device props) and updates the URL.
 * The rail is hidden below `lg` (mobile keeps the header's device switcher).
 */
export default async function DeviceShellLayout({
  children,
}: {
  children: ReactNode;
}) {
  const { userId } = await auth();
  if (!userId) {
    // Middleware already gates /device/*, so this is just a type/edge guard.
    redirect("/sign-in");
  }

  const { systems } = await getViewerDevices(userId);

  return (
    <div className="flex min-h-screen bg-gray-900">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 overflow-y-auto border-r border-gray-800 bg-gray-900 lg:block">
        {/* useSearchParams (period preservation) → Suspense boundary. */}
        <Suspense fallback={null}>
          <DeviceRail devices={systems} currentUserId={userId} />
        </Suspense>
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
