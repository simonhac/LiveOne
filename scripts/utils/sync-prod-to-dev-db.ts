#!/usr/bin/env tsx
/**
 * Thin CLI for the ReadingsDao-owned prod→liveone-dev COPY transfer.
 *
 * Env, safety checks, table order, and output are intentionally unchanged.
 */
import { ReadingsDao } from "@/lib/readings";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`set ${name}`);
  return value;
};

ReadingsDao.syncProdToDev({
  prodUrl: required("PG_PROD_RO_DATABASE_URL"),
  devUrl: required("LIVEONE_DEV_DATABASE_URL"),
  prodBranchId: process.env.PLANETSCALE_PROD_BRANCH_ID,
})
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(
      `✗ ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
