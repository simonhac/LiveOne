import { BaseVendorAdapter } from '../base-adapter';
import type { SystemForVendor, PollingResult, TestConnectionResult } from '../types';
import type { CommonPollingData } from '@/lib/types/common';
import { db } from '@/lib/db';
import { readings } from '@/lib/db/schema';
import { eq, desc } from 'drizzle-orm';

/**
 * Vendor adapter for Fronius systems
 * Fronius systems use push-based data collection
 * The inverter pushes data to our endpoint, we queue it, and process it here
 */
export class FroniusAdapter extends BaseVendorAdapter {
  readonly vendorType = 'fronius';
  readonly displayName = 'Fronius';
  readonly dataSource = 'push' as const;
}