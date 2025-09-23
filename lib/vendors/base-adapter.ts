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
  
  /**
   * Poll for new data. Only applicable for poll-based systems.
   * Push-only systems should not override this method.
   */
  async poll(system: SystemForVendor, credentials: any): Promise<PollingResult> {
    if (this.dataSource === 'push') {
      console.error(`[${this.vendorType}] poll() called on push-only system ${system.id}. This should never happen.`);
      return this.error(`${this.vendorType} is a push-only system and should not be polled`);
    }
    // Polling adapters must override this method
    throw new Error(`poll() not implemented for ${this.vendorType}`);
  }
  
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
    nextPoll?: Date,
    rawResponse?: any
  ): PollingResult {
    return {
      action: 'POLLED',
      data,
      rawResponse,
      recordsProcessed,
      nextPoll
    };
  }
}