import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { isUserAdmin } from "@/lib/auth-utils";
import AdminDashboardClient from "./AdminDashboardClient";

export default async function AdminDashboard() {
  const { userId } = await auth();

  if (!userId) {
    redirect("/sign-in");
  }

  const isAdmin = await isUserAdmin();

  if (!isAdmin) {
    redirect("/dashboard");
  }

  return <AdminDashboardClient />;
}
