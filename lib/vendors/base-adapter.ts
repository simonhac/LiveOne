import type { VendorAdapter, SystemForVendor, PollingResult, TestConnectionResult } from './types';
import type { CommonPollingData } from '@/lib/types/common';
import type { LatestReadingData } from '@/lib/types/readings';
import { db } from '@/lib/db';
import { readings } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';

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

  /**
   * Get the latest reading for this system.
   * Default implementation reads from the readings table.
   * Adapters can override for custom behavior (e.g., CraigHack combines systems).
   */
  async getLastReading(systemId: number): Promise<LatestReadingData | null> {
    const [latestReading] = await db.select()
      .from(readings)
      .where(eq(readings.systemId, systemId))
      .orderBy(desc(readings.inverterTime))
      .limit(1);

    if (!latestReading) {
      return null;
    }

    return {
      timestamp: latestReading.inverterTime,
      receivedTime: latestReading.createdAt,

      solar: {
        powerW: latestReading.solarW,
        localW: latestReading.solarLocalW,
        remoteW: latestReading.solarRemoteW,
      },

      battery: {
        powerW: latestReading.batteryW,
        soc: latestReading.batterySOC,
      },

      load: {
        powerW: latestReading.loadW,
      },

      grid: {
        powerW: latestReading.gridW,
        generatorStatus: latestReading.generatorStatus,
      },

      connection: {
        faultCode: latestReading.faultCode != null ? String(latestReading.faultCode) : null,
        faultTimestamp: latestReading.faultTimestamp,
      },
    };
  }

  /**
   * Test connection with vendor. Push-only systems return an error by default.
   */
  async testConnection(system: SystemForVendor, credentials: any): Promise<TestConnectionResult> {
    if (this.dataSource === 'push') {
      return {
        success: false,
        error: `${this.displayName} systems are push-only and cannot test outgoing connections`
      };
    }
    // Polling adapters must override this method
    throw new Error(`testConnection() not implemented for ${this.vendorType}`);
  }
  
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