import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import ShareTokensClient from "./ShareTokensClient";

export default async function ShareTokensPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  return (
    <main className="min-h-screen bg-gray-900 text-gray-100 p-6">
      <div className="max-w-3xl mx-auto">
        <h1 className="text-2xl font-semibold mb-1">Share tokens</h1>
        <p className="text-sm text-gray-400 mb-6">
          Create view-only links that let anyone see pages for systems you own.
          Append <code className="text-gray-200">?access=&lt;token&gt;</code> to
          the URL of any supported page.
        </p>
        <ShareTokensClient />
      </div>
    </main>
  );
}
