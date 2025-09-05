import { db } from '@/lib/db';
import { pollingStatus } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

/**
 * Get the last polling status for a system
 */
export async function getPollingStatus(systemId: number) {
  const [status] = await db
    .select()
    .from(pollingStatus)
    .where(eq(pollingStatus.systemId, systemId))
    .limit(1);
  
  return status || null;
}

/**
 * Update polling status after a successful poll
 */
export async function updatePollingStatusSuccess(
  systemId: number,
  responseData?: any
) {
  const now = new Date();
  const existingStatus = await getPollingStatus(systemId);
  
  await db
    .insert(pollingStatus)
    .values({
      systemId,
      lastPollTime: now,
      lastSuccessTime: now,
      lastError: null,
      lastResponse: responseData,
      consecutiveErrors: 0,
      totalPolls: 1,
      successfulPolls: 1,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: pollingStatus.systemId,
      set: {
        lastPollTime: now,
        lastSuccessTime: now,
        lastError: null,
        lastResponse: responseData,
        consecutiveErrors: 0,
        totalPolls: existingStatus ? (existingStatus.totalPolls || 0) + 1 : 1,
        successfulPolls: existingStatus ? (existingStatus.successfulPolls || 0) + 1 : 1,
        updatedAt: now
      }
    });
}

/**
 * Update polling status after an error
 */
export async function updatePollingStatusError(
  systemId: number,
  error: Error | string
) {
  const now = new Date();
  const existingStatus = await getPollingStatus(systemId);
  const errorMessage = error instanceof Error ? error.message : error;
  
  await db
    .insert(pollingStatus)
    .values({
      systemId,
      lastPollTime: now,
      lastErrorTime: now,
      lastError: errorMessage,
      lastResponse: null,
      consecutiveErrors: 1,
      totalPolls: 1,
      successfulPolls: 0,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: pollingStatus.systemId,
      set: {
        lastPollTime: now,
        lastErrorTime: now,
        lastError: errorMessage,
        lastResponse: null,
        consecutiveErrors: existingStatus ? (existingStatus.consecutiveErrors || 0) + 1 : 1,
        totalPolls: existingStatus ? (existingStatus.totalPolls || 0) + 1 : 1,
        updatedAt: now
      }
    });
}

/**
 * Common polling result interface
 */
export interface PollingResult {
  systemId: number;
  displayName?: string;
  vendorType?: string;
  status: 'polled' | 'skipped' | 'error';
  recordsUpserted?: number;
  skipReason?: string;
  error?: string;
  durationMs?: number;
  data?: any; // Optional vendor-specific data
}

/**
 * Validate a system for polling
 * Returns a PollingResult with error if validation fails, or null if valid
 */
export function validateSystemForPolling(
  system: any,
  expectedVendorType?: string
): PollingResult | null {
  // Check if system exists
  if (!system) {
    return {
      systemId: 0,
      status: 'error',
      error: 'System not found'
    };
  }
  
  // Check vendor type if specified
  if (expectedVendorType && system.vendorType !== expectedVendorType) {
    return {
      systemId: system.id,
      displayName: system.displayName || undefined,
      vendorType: system.vendorType,
      status: 'error',
      error: `Not a ${expectedVendorType} system (type: ${system.vendorType})`
    };
  }
  
  // Check if owner is configured
  if (!system.ownerClerkUserId) {
    return {
      systemId: system.id,
      displayName: system.displayName || undefined,
      vendorType: system.vendorType,
      status: 'error',
      error: 'No owner configured'
    };
  }
  
  // Validation passed
  return null;
}