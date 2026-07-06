import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getOwnerAreasData } from "@/lib/admin/get-areas-data";
import OwnerAreasClient from "./OwnerAreasClient";

/**
 * Owner-facing "My sites" — the caller's own active Areas, with the same create/edit surface as the
 * admin page (`AreaBuilderDialog`) but scoped to what they own. Owner-gated (any signed-in user), not
 * admin-gated. Mirrors `app/admin/areas/page.tsx` with `getOwnerAreasData(userId)`.
 */
export default async function OwnerAreasPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const data = await getOwnerAreasData(userId);

  return <OwnerAreasClient areas={data.areas} />;
}
