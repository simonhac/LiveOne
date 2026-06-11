/**
 * Dev-seed sync stages.
 *
 * RETIRED in the Phase 5 decommission of the legacy store: this tool copied the prod
 * legacy SQLite store into the local SQLite dev DB. With the legacy store gone, the
 * stages no longer execute. The admin UI still reads the stage metadata
 * (id/name/modifiesMetadata), so the shape is preserved; `execute` throws. Re-point
 * to seed dev from Postgres when needed.
 */

export interface SyncContext {
  db: any;
  prodDb: any;
  signal: AbortSignal;
  updateStage: (id: string, updates: any) => void;
  send: (data: any) => void;
  clerkMappings: Map<string, string>;
  mapClerkId: (prodId: string | null | undefined) => string | undefined;
  systemIdMappings: Map<number, number>;
  mapSystemId: (prodSystemId: number) => number | undefined;
  localLatestTime?: Date;
  syncFromTime?: Date;
  daysToSync: number;
  totalToSync?: number;
  synced?: number;
  recordCounts?: Record<string, number>;
  cumulativeSynced?: number;
  syncStatusMap?: Map<string, { ms?: number; date?: string }>;
  formatDateTime: (date: Date) => string;
}

export interface StageDefinition {
  id: string;
  name: string;
  modifiesMetadata: boolean;
  execute: (context: SyncContext) => Promise<{
    detail?: string;
    context?: Partial<SyncContext>;
  }>;
}

const retired = async (): Promise<{ detail?: string }> => {
  throw new Error(
    "legacy SQLite dev-seed retired in Phase 5 — re-point sync to seed dev from Postgres",
  );
};

export const syncStages: StageDefinition[] = [
  {
    id: "retired",
    name: "Dev-seed retired (legacy store decommissioned)",
    modifiesMetadata: false,
    execute: retired,
  },
];
