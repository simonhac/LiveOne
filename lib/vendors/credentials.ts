import { getVendorCredentials } from '@/lib/secure-credentials';

/**
 * Get vendor-specific credentials for a system
 * This is a unified function that pulls the right section from Clerk metadata
 * Supports optional liveoneSiteId for site-specific credentials
 */
export async function getCredentialsForVendor(
  vendorType: string,
  ownerClerkUserId: string,
  liveoneSiteId?: string
): Promise<any> {
  // In development mode, return dummy credentials for Enphase
  if (process.env.NODE_ENV === 'development' && vendorType.toLowerCase() === 'enphase') {
    console.log('[Enphase] Development mode: Using dummy credentials for testing');
    return {
      access_token: 'dummy_token_for_dev',
      refresh_token: 'dummy_refresh_token',
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours from now
      enphase_system_id: liveoneSiteId || 'dummy_system_id',
      enphase_user_id: 'dev_user',
      created_at: new Date()
    };
  }

  // Map vendor types to their credential keys in Clerk
  const credentialKey = getCredentialKey(vendorType);

  if (!credentialKey) {
    // Some vendors don't need credentials (e.g., craighack, fronius for now)
    return {};
  }

  return getVendorCredentials(ownerClerkUserId, credentialKey as any, liveoneSiteId);
}

/**
 * Map vendor type to the credential key used in Clerk metadata
 */
function getCredentialKey(vendorType: string): string | null {
  switch (vendorType.toLowerCase()) {
    case 'selectronic':
    case 'select.live':
      return 'select.live';

    case 'enphase':
      return 'enphase';

    case 'mondo':
    case 'mondo_power':  // Support both for backward compatibility
      return 'mondo';

    case 'fronius':
      // Will be 'fronius' when we implement real credentials
      return null;

    case 'craighack':
      // CraigHack doesn't need credentials
      return null;

    default:
      return null;
  }
}