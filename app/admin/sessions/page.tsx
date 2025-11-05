import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { isUserAdmin } from "@/lib/auth-utils";
import ActivityViewer from "./activity-viewer";

export default async function ActivityPage() {
  const { userId } = await auth();

  if (!userId) {
    redirect("/sign-in");
  }

  const isAdmin = await isUserAdmin();

  if (!isAdmin) {
    redirect("/dashboard");
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 px-0 md:px-6 pt-3 pb-0 overflow-hidden flex flex-col">
        <ActivityViewer />
      </div>
    </div>
  );
}
