import { auth, clerkClient } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { isUserAdmin } from "@/lib/auth-utils";
import { validateDashboardShareToken } from "@/lib/dashboard/sharing";
import {
  getDashboard,
  getDashboardByOwnerAlias,
  type CompositionDashboard,
} from "@/lib/dashboard/dashboards";
import DashboardClient from "@/components/DashboardClient";
import { getGrant } from "@/lib/dashboard/grants";
import { isDashboardV3, type DashboardV3 } from "@/lib/dashboard/v3";
import { resolveAreasByIds } from "@/lib/areas/list";
import { descriptorAreaIds } from "@/lib/dashboard/composition";

interface PageProps {
  params: Promise<{
    slug: string[];
  }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

/** Resolve a Clerk username → its user id (for `/dashboard/{user}/{shortname}`). Null if none. */
async function resolveClerkUserIdByUsername(
  username: string,
): Promise<string | null> {
  try {
    const clerk = await clerkClient();
    const res = await clerk.users.getUserList({
      username: [username],
      limit: 1,
    });
    return res.data[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Render a nested (v3) dashboard. The descriptor is opaque JSONB; every card/tile self-resolves
 * client-side against its Area's handle or a named member device (the `oe-grid` tile reads the OE
 * region member directly — no server-side region derivation).
 */
async function renderCompositionDashboard(
  dashboard: CompositionDashboard,
  canEdit: boolean,
  sharedAreas?: Awaited<ReturnType<typeof resolveAreasByIds>>,
) {
  const raw: unknown = dashboard.descriptor;
  const descriptor: DashboardV3 = isDashboardV3(raw)
    ? raw
    : { version: 3, sections: [] };
  return (
    <DashboardClient
      dashboard={{
        id: dashboard.id,
        displayName: dashboard.displayName,
        alias: dashboard.alias,
        descriptor,
      }}
      canEdit={canEdit}
      sharedAreas={sharedAreas}
    />
  );
}

/**
 * `/dashboard/*` serves only composition (v3) dashboards now. Per-system "device" views live at
 * `/device/*`; any system-shaped slug here 301s there. A composition is shareable via `?access=`
 * (read-only, no sign-in); the legacy per-system share path is retired.
 */
export default async function DashboardPage({
  params,
  searchParams,
}: PageProps) {
  const { userId } = await auth();
  const { slug } = await params;

  // Shared view: a valid `?access=` token renders the composition dashboard read-only, no sign-in.
  // Resolve the dashboard FROM the token (authoritative; the slug is cosmetic). Invalid/expired
  // tokens fall through to the normal authed flow.
  const sp = await searchParams;
  const accessToken = typeof sp?.access === "string" ? sp.access : undefined;
  if (accessToken) {
    const valid = await validateDashboardShareToken(accessToken);
    if (valid) {
      // The token is authoritative; render the v3 descriptor read-only with the referenced Areas
      // resolved server-side, so each card's data fetch (token-authorized by the live union scope)
      // runs without an authed /api/areas/readable call.
      const composition = await getDashboard(valid.dashboardId);
      if (composition && composition.displayName) {
        const raw: unknown = composition.descriptor;
        const descriptor: DashboardV3 = isDashboardV3(raw)
          ? raw
          : { version: 3, sections: [] };
        const sharedAreas = await resolveAreasByIds(descriptorAreaIds(raw), {
          withChartCapability: true,
        });
        return (
          <DashboardClient
            dashboard={{
              id: composition.id,
              displayName: composition.displayName,
              alias: composition.alias,
              descriptor,
            }}
            canEdit={false}
            sharedAreas={sharedAreas}
          />
        );
      }
    }
  }

  if (!userId) {
    redirect("/sign-in");
  }

  const isAdmin = await isUserAdmin();

  const validSubPages = ["heatmap", "generator", "amber", "latest"] as const;

  // Composition dashboards (Phase 2b-2), addressed by id: `/dashboard/id/{id}` or
  // `/dashboard/{user}/id/{id}` (the {user} segment is cosmetic; access is by ownership/admin).
  const compositionId =
    slug.length === 2 && slug[0] === "id"
      ? slug[1]
      : slug.length === 3 && slug[1] === "id"
        ? slug[2]
        : null;
  if (compositionId && /^\d+$/.test(compositionId)) {
    const dashboard = await getDashboard(parseInt(compositionId, 10));
    if (!dashboard) redirect("/dashboard");
    const canEdit = dashboard.ownerClerkUserId === userId || isAdmin;
    // A signed-in non-owner with a grant views read-only; a true stranger is bounced (a public,
    // sign-in-free share still arrives via ?access=). Grantees get the descriptor's Areas resolved
    // server-side (like the token path) so the client never calls the system-scoped /api/areas/readable.
    const grant = canEdit ? null : await getGrant(dashboard.id, userId);
    if (!canEdit && !grant) redirect("/dashboard");
    const sharedAreas = grant
      ? await resolveAreasByIds(descriptorAreaIds(dashboard.descriptor), {
          withChartCapability: true,
        })
      : undefined;
    return await renderCompositionDashboard(dashboard, canEdit, sharedAreas);
  }

  // Pretty owner-scoped alias: `/dashboard/{user}/{shortname}`. A composition dashboard the caller
  // can edit wins; otherwise it's a system-shaped slug → redirect to the device view.
  if (
    slug.length === 2 &&
    !/^\d+$/.test(slug[0]) &&
    slug[0] !== "id" &&
    slug[1] !== "id" &&
    !validSubPages.includes(slug[1] as (typeof validSubPages)[number])
  ) {
    const ownerId = await resolveClerkUserIdByUsername(slug[0]);
    if (ownerId) {
      const dash = await getDashboardByOwnerAlias(ownerId, slug[1]);
      if (dash && (dash.ownerClerkUserId === userId || isAdmin)) {
        return await renderCompositionDashboard(dash, true);
      }
    }
    // No matching composition dashboard → fall through to the device redirect below.
  }

  // Everything else is a per-system "device" slug (numeric id, user/alias, or a sub-page). Devices
  // now live at /device/*; 301 there preserving the path shape.
  redirect(`/device/${slug.join("/")}`);
}
