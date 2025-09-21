import { getVendorCredentials } from '@/lib/secure-credentials';

/**
 * Get vendor-specific credentials for a system
 * This is a unified function that pulls the right section from Clerk metadata
 */
export async function getCredentialsForVendor(
  ownerClerkUserId: string,
  vendorType: string
): Promise<any> {
  // Map vendor types to their credential keys in Clerk
  const credentialKey = getCredentialKey(vendorType);
  
  if (!credentialKey) {
    // Some vendors don't need credentials (e.g., craighack, fronius for now)
    return {};
  }
  
  return getVendorCredentials(ownerClerkUserId, credentialKey as any);
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