import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { isUserAdmin } from "@/lib/auth-utils";

export default async function StoragePage() {
  const authResult = await auth();

  if (!authResult.userId) {
    redirect("/sign-in");
  }

  const isAdmin = await isUserAdmin(authResult);

  if (!isAdmin) {
    redirect("/dashboard");
  }

  return (
    <main className="px-2 py-4 sm:px-6 sm:py-8">
      <section className="max-w-3xl">
        <h1 className="text-2xl font-semibold text-white">Database Admin</h1>
        <p className="mt-3 text-sm leading-6 text-gray-300">
          The old Turso/SQLite database admin tools have been stripped back
          after the Postgres cutover. This page is intentionally a placeholder
          while the Postgres-native admin surface is redesigned.
        </p>
        <p className="mt-3 text-sm leading-6 text-gray-400">
          The previous behavior and rebuild notes are documented in{" "}
          <code className="rounded bg-gray-800 px-1.5 py-0.5 text-gray-200">
            docs/old-database-admin.md
          </code>
          .
        </p>
      </section>
    </main>
  );
}
