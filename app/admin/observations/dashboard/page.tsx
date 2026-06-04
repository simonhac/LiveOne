import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { isUserAdmin } from "@/lib/auth-utils";
import ObservationsDashboard from "./dashboard-view";

export default async function ObservationsDashboardPage() {
  const authResult = await auth();

  if (!authResult.userId) {
    redirect("/sign-in");
  }

  const isAdmin = await isUserAdmin(authResult);

  if (!isAdmin) {
    redirect("/dashboard");
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 px-3 md:px-6 pt-3 pb-6 overflow-y-auto">
        <ObservationsDashboard />
      </div>
    </div>
  );
}
