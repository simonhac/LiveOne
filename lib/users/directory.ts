/**
 * The user directory: the Clerk ⋈ owned-devices join that `GET /api/admin/users` has always served,
 * factored out so the v4 CLI routes (`/api/v4/users*`) can serve the SAME entries — one assembly, two
 * doors, no drift in what "a user" looks like on the wire.
 *
 * Users are discovered by device OWNERSHIP, not by enumerating Clerk: there used to be a second leg
 * (a full-table `user_systems` join) that contributed grant-only users, but that table died in
 * migration 0045, so a user who appears ONLY via a grant does not appear at all, and every listed
 * device is one the user owns (hence no `role` field).
 *
 * A Clerk fetch failure does not drop the user — they demonstrably exist (they own devices), so the
 * entry degrades to ids + devices with the Clerk-side fields undefined, exactly as the admin route
 * has always done. `createdAt` is a Clerk epoch-ms number on the happy path and an ISO string on the
 * degraded one; both feed `new Date()` for the sort, and the union is preserved rather than papered
 * over because the admin UI already consumes it.
 */
import { clerkClient } from "@clerk/nextjs/server";
import {
  DeviceConfigRegistry,
  type DeviceRecord,
} from "@/lib/registry/device-config";

export interface UserDeviceAccess {
  systemId: number;
  vendorType: string;
  vendorSiteId: string;
  displayName: string;
  status: string;
}

export interface UserDirectoryEntry {
  clerkUserId: string;
  email?: string;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  createdAt: number | string;
  lastSignIn?: number | null;
  devices: UserDeviceAccess[];
  isPlatformAdmin?: boolean;
}

function toDeviceAccess(device: DeviceRecord): UserDeviceAccess {
  return {
    systemId: device.id,
    vendorType: device.vendorType,
    vendorSiteId: device.vendorSiteId,
    displayName: device.displayName,
    status: device.status,
  };
}

/** One entry from Clerk, or null if the Clerk fetch fails (unknown id OR outage — Clerk's 404 is
 * an error like any other here, so the caller decides what "unresolvable" means for its door). */
async function resolvedEntry(
  clerkUserId: string,
  devices: UserDeviceAccess[],
): Promise<UserDirectoryEntry | null> {
  try {
    const client = await clerkClient();
    const clerkUser = await client.users.getUser(clerkUserId);

    let isPlatformAdmin = false;
    if (
      clerkUser.privateMetadata &&
      typeof clerkUser.privateMetadata === "object"
    ) {
      const metadata = clerkUser.privateMetadata as Record<string, unknown>;
      isPlatformAdmin = metadata.isPlatformAdmin === true;
    }

    return {
      clerkUserId,
      email: clerkUser.emailAddresses[0]?.emailAddress,
      firstName: clerkUser.firstName,
      lastName: clerkUser.lastName,
      username: clerkUser.username,
      createdAt: clerkUser.createdAt,
      lastSignIn: clerkUser.lastSignInAt,
      devices,
      isPlatformAdmin,
    };
  } catch (err) {
    console.error(`Failed to fetch Clerk user ${clerkUserId}:`, err);
    return null;
  }
}

/** The degraded entry for a user Clerk could not resolve but device ownership proves exists. */
function unresolvedEntry(
  clerkUserId: string,
  devices: UserDeviceAccess[],
): UserDirectoryEntry {
  return {
    clerkUserId,
    email: undefined,
    firstName: undefined,
    lastName: undefined,
    createdAt: new Date().toISOString(),
    lastSignIn: undefined,
    devices,
  };
}

/** Every device-owning user, newest first — the admin-route list, verbatim. */
export async function listUserDirectory(): Promise<UserDirectoryEntry[]> {
  const allDevices = await DeviceConfigRegistry.allDevices();

  const uniqueUserIds = [
    ...new Set(
      allDevices
        .map((d) => d.ownerClerkUserId)
        .filter((id): id is string => id !== null),
    ),
  ];

  const usersData: UserDirectoryEntry[] = [];
  for (const clerkUserId of uniqueUserIds) {
    const ownedDevices = allDevices
      .filter((d) => d.ownerClerkUserId === clerkUserId)
      .map(toDeviceAccess);
    usersData.push(
      (await resolvedEntry(clerkUserId, ownedDevices)) ??
        unresolvedEntry(clerkUserId, ownedDevices),
    );
  }

  usersData.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return usersData;
}

/**
 * One user by Clerk id, or null for "unknown". Broader than the list on purpose — a user who owns no
 * devices still resolves (with an empty `devices`), because "addressable by id" should not depend on
 * fleet state. Null only when Clerk cannot resolve the id AND no device ownership vouches for it;
 * when ownership does, the entry degrades exactly as the list's does.
 */
export async function userDirectoryEntry(
  clerkUserId: string,
): Promise<UserDirectoryEntry | null> {
  const allDevices = await DeviceConfigRegistry.allDevices();
  const ownedDevices = allDevices
    .filter((d) => d.ownerClerkUserId === clerkUserId)
    .map(toDeviceAccess);

  const entry = await resolvedEntry(clerkUserId, ownedDevices);
  if (entry) return entry;
  return ownedDevices.length > 0
    ? unresolvedEntry(clerkUserId, ownedDevices)
    : null;
}
