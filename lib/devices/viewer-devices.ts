import { cache } from "react";
import { clerkClient } from "@clerk/nextjs/server";
import { SystemsManager } from "@/lib/systems-manager";

/** The exact element shape `getSystemsVisibleByUser` returns (a projection, narrower than System). */
type VisibleSystem = Awaited<
  ReturnType<SystemsManager["getSystemsVisibleByUser"]>
>[number];

/** A visible device with the viewer's Clerk username attached to the ones they own (for pretty URLs). */
export type ViewerDevice = VisibleSystem & { ownerUsername: string | null };

export interface ViewerDevices {
  /** The viewer's Clerk username (null if unset / lookup failed) — used for `/device/{user}/{alias}`. */
  currentUsername: string | null;
  /** The viewer's visible devices (owned ∪ public ∪ granted, active only), owned ones tagged with the username. */
  systems: ViewerDevice[];
}

/**
 * The viewer's device list + their Clerk username, shared by the `/device` shell layout (for the rail)
 * and the device page (for the header switcher). Wrapped in React `cache()` so both server components
 * dedupe the `getSystemsVisibleByUser` query + the Clerk lookup within a single request. The Clerk
 * lookup is defensive (dev mirrors prod owner ids on a different Clerk instance) — a failure just means
 * no pretty-URL username, never a 500.
 */
export const getViewerDevices = cache(
  async (userId: string): Promise<ViewerDevices> => {
    const availableSystems =
      await SystemsManager.getInstance().getSystemsVisibleByUser(userId, true);

    let currentUsername: string | null = null;
    try {
      const clerk = await clerkClient();
      const currentUser = await clerk.users.getUser(userId);
      currentUsername = currentUser.username || null;
    } catch {
      currentUsername = null;
    }

    const systems: ViewerDevice[] = availableSystems.map((sys) => ({
      ...sys,
      ownerUsername: sys.ownerClerkUserId === userId ? currentUsername : null,
    }));

    return { currentUsername, systems };
  },
);
