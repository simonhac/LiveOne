/**
 * Helper functions for Select.Live credentials
 */

import { getVendorCredentials, storeVendorCredentials, removeVendorCredentials, type VendorCredentials } from '@/lib/secure-credentials';

// Select.Live specific credential shape
export interface SelectLiveCredentials extends VendorCredentials {
  email: string;
  password: string;
}

/**
 * Get Select.Live credentials specifically
 */
export async function getSelectLiveCredentials(
  userId: string
): Promise<SelectLiveCredentials | null> {
  return getVendorCredentials(userId, 'select.live') as Promise<SelectLiveCredentials | null>
}

/**
 * Store Select.Live credentials
 */
export async function storeSelectLiveCredentials(
  userId: string,
  credentials: SelectLiveCredentials
) {
  return storeVendorCredentials(userId, 'select.live', credentials)
}

/**
 * Remove Select.Live credentials
 */
export async function removeSelectLiveCredentials(
  userId: string
) {
  return removeVendorCredentials(userId, 'select.live')
}