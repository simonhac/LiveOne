"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Layers } from "lucide-react";
import type { AdminAreaData } from "@/lib/admin/get-areas-data";
import AreaBuilderDialog from "@/components/area-builder/AreaBuilderDialog";
import { AreaTable } from "@/components/areas/AreaTable";

/**
 * The owner "My sites" list. A near-copy of `AdminAreasClient` (same dialog state machine + shared
 * `AreaTable`) but wrapped in its own page chrome (there is no admin sidebar here) and owner-scoped:
 * the Owner column is dropped since every row is the caller.
 */
export default function OwnerAreasClient({
  areas,
}: {
  areas: AdminAreaData[];
}) {
  const router = useRouter();
  // `undefined` = closed; `null` = create mode; a uuid = edit that area.
  const [dialogAreaId, setDialogAreaId] = useState<string | null | undefined>(
    undefined,
  );

  return (
    <main className="min-h-screen bg-gray-900 text-gray-100">
      <div className="mx-auto max-w-5xl px-2 md:px-6 py-8 space-y-6">
        <div>
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1.5 text-sm text-gray-400 transition-colors hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to dashboard
          </Link>
          <h1 className="mt-3 text-2xl font-semibold">My sites</h1>
          <p className="mt-1 text-sm text-gray-400">
            Sites you own — group devices, set a location, and manage role→point
            bindings. To show a site on a dashboard, open that dashboard and use
            its <span className="text-gray-200">Add area</span> button.
          </p>
        </div>
        <AreaTable
          title="Sites"
          subtitle="Each site groups 1..N of your devices; bindings are role→point overrides."
          icon={<Layers className="h-5 w-5 text-purple-400" />}
          areas={areas}
          onNew={() => setDialogAreaId(null)}
          onEdit={(id) => setDialogAreaId(id)}
          newLabel="New site"
          emptyLabel="You don't have any sites yet."
          showOwner={false}
        />
      </div>
      <AreaBuilderDialog
        isOpen={dialogAreaId !== undefined}
        areaId={dialogAreaId ?? null}
        onClose={() => setDialogAreaId(undefined)}
        onSaved={() => router.refresh()}
      />
    </main>
  );
}
