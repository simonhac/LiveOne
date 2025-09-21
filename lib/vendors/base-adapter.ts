import type { VendorAdapter, SystemForVendor, PollingResult, TestConnectionResult } from './types';
import type { CommonPollingData } from '@/lib/types/common';

/**
 * Base adapter class that provides common functionality
 * Vendor-specific adapters can extend this class
 */
export abstract class BaseVendorAdapter implements VendorAdapter {
  abstract readonly vendorType: string;
  abstract readonly displayName: string;
  abstract readonly dataSource: 'poll' | 'push' | 'combined';
  
  abstract poll(system: SystemForVendor, credentials: any): Promise<PollingResult>;
  abstract getMostRecentReadings(system: SystemForVendor, credentials: any): Promise<CommonPollingData | null>;
  abstract testConnection(system: SystemForVendor, credentials: any): Promise<TestConnectionResult>;
  
  /**
   * Helper to create a SKIPPED result
   */
  protected skipped(reason: string, nextPoll?: Date): PollingResult {
    return {
      action: 'SKIPPED',
      reason,
      nextPoll
    };
  }
  
  /**
   * Helper to create an ERROR result
   */
  protected error(error: string | Error): PollingResult {
    return {
      action: 'ERROR',
      error: error instanceof Error ? error.message : error
    };
  }
  
  /**
   * Helper to create a POLLED result
   */
  protected polled(
    data: CommonPollingData | CommonPollingData[], 
    recordsProcessed: number,
    nextPoll?: Date
  ): PollingResult {
    return {
      action: 'POLLED',
      data,
      recordsProcessed,
      nextPoll
    };
  }
}