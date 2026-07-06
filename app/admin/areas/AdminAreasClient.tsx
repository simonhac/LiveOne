"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Layers } from "lucide-react";
import type { AdminAreaData } from "@/lib/admin/get-areas-data";
import AreaBuilderDialog from "@/components/area-builder/AreaBuilderDialog";
import { AreaTable } from "@/components/areas/AreaTable";

export default function AdminAreasClient({
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
    <div className="flex flex-col h-full max-h-full">
      <div className="flex-1 px-0 md:px-6 py-8 overflow-auto space-y-8">
        <AreaTable
          title="Areas"
          subtitle="Each Area groups 1..N member devices; bindings are role→point overrides."
          icon={<Layers className="w-5 h-5 text-purple-400" />}
          areas={areas}
          onNew={() => setDialogAreaId(null)}
          onEdit={(id) => setDialogAreaId(id)}
        />
      </div>
      <AreaBuilderDialog
        isOpen={dialogAreaId !== undefined}
        areaId={dialogAreaId ?? null}
        onClose={() => setDialogAreaId(undefined)}
        onSaved={() => router.refresh()}
      />
    </div>
  );
}
