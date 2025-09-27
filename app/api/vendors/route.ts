import { NextResponse } from 'next/server';
import { VendorRegistry } from '@/lib/vendors/registry';

export async function GET() {
  try {
    // Get all vendor adapters
    const allVendors = VendorRegistry.getAllAdapters();

    // Filter to only vendors that support the Add System flow
    const supportedVendors = allVendors
      .filter(adapter => adapter.supportsAddSystem && adapter.credentialFields)
      .map(adapter => ({
        vendorType: adapter.vendorType,
        displayName: adapter.displayName,
        credentialFields: adapter.credentialFields
      }));

    return NextResponse.json({
      vendors: supportedVendors
    });
  } catch (error) {
    console.error('[Vendors API] Error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch vendors' },
      { status: 500 }
    );
  }
}