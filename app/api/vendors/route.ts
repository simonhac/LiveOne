import { NextResponse } from "next/server";
import { VendorRegistry } from "@/lib/vendors/registry";

export async function GET() {
  try {
    // Get all vendor adapters
    const allVendors = VendorRegistry.getAllAdapters();

    // Filter to vendors that support the Add System flow. Credential vendors expose
    // credentialFields; OAuth vendors (Tesla) expose addSystemFlow === "oauth-paste".
    const supportedVendors = allVendors
      .filter(
        (adapter) =>
          adapter.supportsAddSystem &&
          (adapter.addSystemFlow === "oauth-paste" ||
            (adapter.credentialFields?.length ?? 0) > 0),
      )
      .map((adapter) => ({
        vendorType: adapter.vendorType,
        displayName: adapter.displayName,
        addSystemFlow: adapter.addSystemFlow ?? "credentials",
        credentialFields: adapter.credentialFields ?? [],
      }));

    return NextResponse.json({
      vendors: supportedVendors,
    });
  } catch (error) {
    console.error("[Vendors API] Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch vendors" },
      { status: 500 },
    );
  }
}
