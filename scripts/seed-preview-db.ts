#!/usr/bin/env tsx
/**
 * Thin CLI for the ReadingsDao-owned preview database seeder.
 *
 * Env and behavior are intentionally unchanged; see ReadingsDao.seedPreviewDatabase.
 */
import { ReadingsDao } from "@/lib/readings";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
};

ReadingsDao.seedPreviewDatabase({
  sourceUrl: required("SOURCE_DATABASE_URL"),
  targetUrl: required("TARGET_DATABASE_URL"),
  seedDays: Number(process.env.SEED_DAYS ?? 10),
  seedDaysDaily: Number(process.env.SEED_DAYS_DAILY ?? 45),
})
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
