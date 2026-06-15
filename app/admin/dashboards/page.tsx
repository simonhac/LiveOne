import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { isUserAdmin } from "@/lib/auth-utils";
import { getAdminDashboardsData } from "@/lib/admin/get-dashboards-data";
import AdminDashboardsClient from "./AdminDashboardsClient";

export default async function AdminDashboardsPage() {
  const authResult = await auth();

  if (!authResult.userId) {
    redirect("/sign-in");
  }

  const isAdmin = await isUserAdmin(authResult);

  if (!isAdmin) {
    redirect("/dashboard");
  }

  const data = await getAdminDashboardsData();

  return <AdminDashboardsClient dashboards={data.dashboards} />;
}
