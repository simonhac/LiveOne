import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { isUserAdmin } from "@/lib/auth-utils";
import { getAdminSystemsData } from "@/lib/admin/get-systems-data";
import AdminDashboardClient from "./AdminDashboardClient";

export default async function AdminDashboard() {
  const authResult = await auth();

  if (!authResult.userId) {
    redirect("/sign-in");
  }

  // Pass auth result to avoid redundant auth() call inside isUserAdmin
  const isAdmin = await isUserAdmin(authResult);

  if (!isAdmin) {
    redirect("/dashboard");
  }

  // Fetch systems data server-side with 100ms timeout for latest values
  // If KV is slow, page renders immediately and client fetches latest values
  const initialData = await getAdminSystemsData({ latestValuesTimeoutMs: 100 });

  return (
    <AdminDashboardClient
      initialSystems={initialData.systems}
      latestValuesIncluded={initialData.latestValuesIncluded}
    />
  );
}
