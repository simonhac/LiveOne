import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { isUserAdmin } from "@/lib/auth-utils";
import StorageTools from "./StorageTools";
import { syncStages } from "@/app/api/admin/sync-database/stages";

export default async function StoragePage() {
  const authResult = await auth();

  if (!authResult.userId) {
    redirect("/sign-in");
  }

  const isAdmin = await isUserAdmin(authResult);

  if (!isAdmin) {
    redirect("/dashboard");
  }

  // Prepare stages data for the client component
  const stages = syncStages.map((stage) => ({
    id: stage.id,
    name: stage.name,
    modifiesMetadata: stage.modifiesMetadata,
  }));

  return <StorageTools initialStages={stages} />;
}
