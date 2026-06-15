import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { isUserAdmin } from "@/lib/auth-utils";
import { getAdminAreasData } from "@/lib/admin/get-areas-data";
import AdminAreasClient from "./AdminAreasClient";

export default async function AdminAreasPage() {
  const authResult = await auth();

  if (!authResult.userId) {
    redirect("/sign-in");
  }

  const isAdmin = await isUserAdmin(authResult);

  if (!isAdmin) {
    redirect("/dashboard");
  }

  const data = await getAdminAreasData();

  return <AdminAreasClient areas={data.areas} />;
}
