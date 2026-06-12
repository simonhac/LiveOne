import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { registerTeslaPartner } from "@/lib/vendors/tesla/tesla-client";

const DEFAULT_DOMAIN = "liveone.energy";

/**
 * Admin-only, one-time Fleet API partner registration.
 *
 * Run once per environment after the public key is live at
 * /.well-known/appspecific/com.tesla.3p.public-key.pem. Optional body:
 *   { "domain": "liveone.energy", "baseUrl": "https://fleet-api.prd.na.vn.cloud.tesla.com" }
 * In dev, authenticate with the `x-claude: true` header.
 */
export async function POST(request: NextRequest) {
  const authResult = await requireAdmin(request);
  if (authResult instanceof NextResponse) return authResult;

  try {
    const body = (await request.json().catch(() => ({}))) as {
      domain?: string;
      baseUrl?: string;
    };
    const domain = body.domain || DEFAULT_DOMAIN;

    const result = await registerTeslaPartner({
      domain,
      baseUrl: body.baseUrl,
    });

    return NextResponse.json({
      domain,
      teslaStatus: result.status,
      teslaResponse: result.body,
    });
  } catch (error) {
    console.error("[Tesla] Partner registration failed:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Registration failed",
      },
      { status: 500 },
    );
  }
}
