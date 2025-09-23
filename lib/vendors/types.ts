import type { CommonPollingData } from '@/lib/types/common';

/**
 * Vendor adapter interface for all energy system vendors
 */
export interface VendorAdapter {
  // Basic vendor information
  readonly vendorType: string;
  readonly displayName: string;
  readonly dataSource: 'poll' | 'push' | 'combined';
  
  // Main polling function - handles all data collection
  poll(system: SystemForVendor, credentials: any): Promise<PollingResult>;
  
  // Get most recent readings for real-time display
  getMostRecentReadings(system: SystemForVendor, credentials: any): Promise<CommonPollingData | null>;
  
  // Test connection with vendor
  testConnection(system: SystemForVendor, credentials: any): Promise<TestConnectionResult>;
}

/**
 * System type for vendor operations
 * Based on the systems table schema but with required fields for vendor operations
 */
export interface SystemForVendor {
  id: number;
  vendorType: string;
  vendorSiteId: string;
  ownerClerkUserId: string;
  displayName: string | null;
  timezoneOffsetMin: number;
  isActive: boolean;
  model?: string | null;
  serial?: string | null;
  ratings?: string | null;
  solarSize?: string | null;
  batterySize?: string | null;
}

/**
 * Result from a polling operation
 */
export interface PollingResult {
  action: 'POLLED' | 'SKIPPED' | 'ERROR';
  data?: CommonPollingData | CommonPollingData[];  // The transformed data
  rawResponse?: any;  // Raw vendor response for storage
  recordsProcessed?: number;  // For POLLED
  reason?: string;  // For SKIPPED or ERROR
  error?: string;  // For ERROR
  nextPoll?: Date;  // When to poll next
}

/**
 * Result from testing a connection
 */
export interface TestConnectionResult {
  success: boolean;
  systemInfo?: {
    model?: string | null;
    serial?: string | null;
    ratings?: string | null;
    solarSize?: string | null;
    batterySize?: string | null;
  };
  latestData?: CommonPollingData;
  vendorResponse?: any;  // Raw vendor response for debugging
  error?: string;
}